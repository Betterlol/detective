import { z } from 'zod';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ThreadItem } from '@openai/codex-sdk';
import { agentOptions, createCodexClient, runLoggedThread, type AgentClient, type AgentThread } from './sdk-run.js';
import { readAuthorArtifact, toolHistory, toolMarker, type ToolMode, type ToolReport } from './author-tools.js';
import { startFoundationBroker } from './foundation-broker.js';
import type { DetectiveConfig } from './config.js';
import { foundationReviewKey } from './foundation-broker.js';
import { designReviewAccepted, designReviewSchema } from './design-review.js';
import { auditDesign } from './design-validation.js';
import { hash, readJson, saveJson } from './io.js';
import type { ModelConfig } from './provider.js';
import { fixedModelConfig } from './model-policy.js';
import { defaultDetectiveConfig } from './config.js';

export type AuthorStage = 'design' | 'build' | 'polish' | 'repair';
export class ContentSubmissionError extends Error {}
const receiptSchema = z.object({ artifactPath: z.enum(['design.json', 'case.json']), summary: z.string().min(1), requestDesignRevision: z.boolean() }).strict();
export const trustedToolPath = fileURLToPath(new URL('../dist/author-tools.js', import.meta.url));
let prepared: Promise<void> | undefined;
export function prepareAuthorTools() {
  return prepared ??= (async () => {
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/build-tools.mjs', import.meta.url))], { windowsHide: true });
  })();
}
function quote(value: string) { return process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`; }
function baseToolCommand(workspace: string, mode: ToolMode) {
  return `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(trustedToolPath)} ${quote(resolve(workspace))} ${mode}`;
}
export function toolCommand(workspace: string, mode: ToolMode, searchStateLimit = defaultDetectiveConfig.validation.searchStateLimit) {
  return `${baseToolCommand(workspace, mode)} ${searchStateLimit}`;
}
export function trustedValidation(items: ThreadItem[], workspace: string, mode: ToolMode, artifactHash: string,
  searchStateLimit = defaultDetectiveConfig.validation.searchStateLimit): ToolReport | null {
  const normalize = (text: string) => text.replace(/\\+/g, '/').replace(/\/+/g, '/').toLowerCase();
  for (const item of items) {
    if (item.type !== 'command_execution' || (item.exit_code !== 0 && !(mode === 'foundation-review' && item.exit_code === 1)) || item.status !== 'completed' ||
      (!normalize(item.command).includes(normalize(toolCommand(workspace, mode, searchStateLimit))) &&
        !(searchStateLimit === defaultDetectiveConfig.validation.searchStateLimit &&
          normalize(item.command).includes(normalize(baseToolCommand(workspace, mode)))))) continue;
    for (const line of item.aggregated_output.split(/\r?\n/)) {
      try {
        const report = JSON.parse(line) as ToolReport;
        if (report.tool === toolMarker && report.mode === mode && (report.ok || mode === 'foundation-review') &&
          normalize(resolve(report.workspace)) === normalize(resolve(workspace)) &&
          (mode === 'design' || mode === 'foundation-review' ? report.designHash : report.caseHash) === artifactHash &&
          report.searchStateLimit === searchStateLimit) return report;
      } catch { /* Only the trusted JSON report line is relevant. */ }
    }
  }
  return null;
}
type StageRecord = { stage: AuthorStage; directory: string; status: string; threadId?: string; artifactHash?: string };
export type AuthorState = { version: 'sdk-author-1.0'; threadId: string | null; workspace: string; stages: StageRecord[] };

export class AuthorSession {
  readonly toolDrivenReview = true;
  private constructor(readonly output: string, readonly workspace: string, private config: ModelConfig,
    private thread: AgentThread, readonly state: AuthorState, private searchStateLimit: number) {}
  static async open(output: string, config: ModelConfig, resume = false, client: AgentClient = createCodexClient(),
    searchStateLimit = defaultDetectiveConfig.validation.searchStateLimit) {
    config = fixedModelConfig(config);
    await prepareAuthorTools();
    if (config.provider !== 'codex') throw new Error('文件作者模式需要 Codex SDK；Responses 仅支持显式兼容生成');
    const root = resolve(output), workspace = join(root, 'author'); await mkdir(workspace, { recursive: true });
    const state: AuthorState = resume ? await readJson(join(root, 'author-session.json')) as AuthorState :
      { version: 'sdk-author-1.0', threadId: null, workspace, stages: [] };
    if (state.version !== 'sdk-author-1.0' || resolve(state.workspace) !== workspace || (resume && !state.threadId))
      throw new Error('作者会话记录无效或缺少可恢复 ID');
    const options = agentOptions(config, workspace, true);
    const thread = state.threadId ? client.resumeThread(state.threadId, options) : client.startThread(options);
    const author = new AuthorSession(root, workspace, config, thread, state, searchStateLimit); await author.save(); return author;
  }
  private save() { return saveJson(join(this.output, 'author-session.json'), this.state); }
  async run(stage: AuthorStage, instructions: string, directory: string) {
    const mode: ToolMode = stage === 'design' ? 'design' : 'case';
    const artifactPath = mode === 'design' ? 'design.json' : 'case.json';
    const record: StageRecord = { stage, directory: relative(this.output, resolve(directory)), status: 'running' };
    this.state.stages.push(record); await this.save();
    const historyStart = (await toolHistory(this.workspace)).length;
    let stopBroker: (() => Promise<void>) | undefined;
    if (this.toolDrivenReview) {
      const manifest = await readJson(join(this.output, 'manifest.json')).catch(() => null) as { settings?: DetectiveConfig; maxDesignRepairs?: number } | null;
      if (manifest?.settings) stopBroker = startFoundationBroker(this.workspace, manifest.settings, (manifest.maxDesignRepairs ?? manifest.settings.generation.maxDesignRepairs) + 1);
    }
    instructions += '\n只有工具 ok=true、整体 verdict=pass 且 facts/mechanism/identity/revealPlan 全部 pass，才是已通过设计。某分项 revise 即使 issues 标 minor 也必须修复，不能选择性忽略。全部已通过且仅 minor 时，可以提交当前版本，minor 在不改变基石事实的文案阶段落实。';
    await saveJson(join(this.workspace, 'feedback.json'), { stage, feedback: instructions });
    const prompt = `${instructions}\n\n这是用户已批准的阶段，直接执行，不再等待方案批准。你是持续工作的案件作者 Agent。请创建或局部编辑 ${artifactPath}；最终只交回执，不重复整案。不要修改可信工具、程序或 .detective-tools 内的缓存与记录，不委派，不访问其他案件。连续编辑不会触发检查。你自行安排构建、润色和检查，候选提交后由程序完整验收。\n可真实调用的工具（JSON反馈含 ok、issues 的 code/path/message、failureKind、文件哈希、耗时和缓存信息）：\n` +
      `设计格式/引用（不调用模型）：${toolCommand(this.workspace, 'design', this.searchStateLimit)}\n` +
      `主动请求隔离设计评审（遵守 foundationReview；关闭时不调用模型）：${toolCommand(this.workspace, 'foundation-review', this.searchStateLimit)}\n` +
      (mode === 'case' ? `快速静态检查（不搜索状态）：${toolCommand(this.workspace, 'quick', this.searchStateLimit)}\n完整规则、可解性与设计一致性：${toolCommand(this.workspace, 'case', this.searchStateLimit)}\n玩家文字回放（复用同版本搜索，包含问题出现前的玩家视图）：${toolCommand(this.workspace, 'replay', this.searchStateLimit)}\n` : '') +
      '中间检查时机由你决定；不必每次编辑完整检查。建议先解决静态错误、再完整检查、看回放。设计评审开启时须主动请求评审并处理 blocking，程序不会替你自动追加评审调用。设计评审最多首次加配置修复次数；工具总预算：design 12、quick 24、case 12、replay 12；工具执行失败同原因最多重试2次，传输失败停止并交回执；不能无上限反复调用。\n' +
      'foundation-review 是长工具：命令返回运行中的 session_id 时，继续轮询同一进程直到拿到 JSON 反馈；不在反馈返回前交回执，不重复启动同一请求。复杂局部编辑使用 apply_patch，或先写本地脚本再运行，避免 PowerShell -e 内嵌长 JavaScript 字符串。\n' +
      (mode === 'case' ? `若核心事实必须修订，可以同时编辑 design.json 和 case.json，再主动请求设计评审；返回 requestDesignRevision=true、artifactPath=design.json。程序会先验收设计，再验收已准备的 case.json，无需重新输出整案。\n` : '') +
      '最终仅返回工作回执 JSON，artifactPath 为本轮文件名，summary 说明具体修改和检查结果；正常完成 requestDesignRevision=false。';
    try {
      const run = await runLoggedThread(this.thread, prompt, z.toJSONSchema(receiptSchema), directory, this.config, true,
        async id => { this.state.threadId = id; record.threadId = id; await this.save(); });
      await stopBroker?.(); stopBroker = undefined;
      let receipt: z.infer<typeof receiptSchema>;
      try { receipt = receiptSchema.parse(JSON.parse(run.finalResponse)); }
      catch (e) { throw new ContentSubmissionError(`工作回执格式不合法：${String(e)}`); }
      const revision = mode === 'case' && receipt.requestDesignRevision;
      const expectedPath = revision ? 'design.json' : artifactPath;
      if (receipt.artifactPath !== expectedPath) throw new ContentSubmissionError('作者回执的文件与当前阶段不一致');
      let artifact;
      try { artifact = await readAuthorArtifact(this.workspace, expectedPath); }
      catch (e) { if (e instanceof SyntaxError || (e as NodeJS.ErrnoException).code === 'ENOENT') throw new ContentSubmissionError(`候选缺失或 JSON 不合法：${String(e)}`); throw e; }
      const artifactHash = hash(artifact);
      await saveJson(join(directory, 'artifact.json'), artifact);
      const evidence = trustedValidation(run.items, this.workspace, revision ? 'design' : mode, artifactHash, this.searchStateLimit) ??
        (!revision && mode === 'case' ? trustedValidation(run.items, this.workspace, 'replay', artifactHash, this.searchStateLimit) : null);
      await saveJson(join(directory, 'validation-evidence.json'), evidence);
      let reviewEvidence = trustedValidation(run.items, this.workspace, 'foundation-review',
        hash(await readAuthorArtifact(this.workspace, 'design.json')), this.searchStateLimit);
      if (!reviewEvidence) {
        const manifest = await readJson(join(this.output, 'manifest.json')).catch(() => null) as { settings?: DetectiveConfig } | null;
        const designHash = hash(await readAuthorArtifact(this.workspace, 'design.json'));
        if (manifest?.settings) for (const prior of this.state.stages.slice(0, -1).reverse()) {
          try {
            const priorEvidence = await readJson(join(this.output, prior.directory, 'review-evidence.json')) as ToolReport | null;
            const key = await foundationReviewKey(designHash, manifest.settings);
            if (priorEvidence?.designHash === designHash && priorEvidence.review &&
              priorEvidence.reviewDirectory?.replace(/\\/g, '/') === `.detective-tools/reviews/${key}`) { reviewEvidence = priorEvidence; break; }
          } catch { /* Earlier interrupted rounds may have no receipt. */ }
        }
      }
      // A long command may remain in-progress when the author submits. Its explicit file request still
      // authorizes the broker; wait for that request and bind the real isolated result, never infer a pass.
      if (!reviewEvidence) {
        const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(x => JSON.parse(x));
        const normalize = (s: string) => s.replace(/\\+/g, '/').replace(/\/+/g, '/').toLowerCase();
        const requested = events.some(x => x.type === 'item.started' && x.item?.type === 'command_execution' &&
          normalize(x.item.command).includes(normalize(toolCommand(this.workspace, 'foundation-review', this.searchStateLimit))));
        const manifest = await readJson(join(this.output, 'manifest.json')).catch(() => null) as { settings?: DetectiveConfig } | null;
        if (requested && manifest?.settings?.workflow.foundationReview) {
          const rawDesign = await readAuthorArtifact(this.workspace, 'design.json'), d = auditDesign(rawDesign);
          const key = await foundationReviewKey(hash(rawDesign), manifest.settings);
          try {
            const request = await readJson(join(this.workspace, '.detective-tools/review-requests', key + '.json')) as { design: unknown; key: string };
            const reviewDirectory = join('.detective-tools', 'reviews', key);
            const review = designReviewSchema.parse(await readJson(join(this.workspace, reviewDirectory, 'review.json')));
            if (d.ok && d.design && request.key === key && hash(request.design) === hash(rawDesign))
              reviewEvidence = { tool: toolMarker, mode: 'foundation-review', workspace: this.workspace, designHash: hash(rawDesign),
                caseHash: null, searchStateLimit: this.searchStateLimit, ok: designReviewAccepted(d.design, review), issues: [], reviewDirectory, review };
          } catch { /* Missing/failed requests cannot be accepted. */ }
        }
      }
      await saveJson(join(directory, 'review-evidence.json'), reviewEvidence);
      record.status = 'completed'; record.threadId = run.threadId; record.artifactHash = artifactHash;
      await this.save();
      const toolFailureKind = (await toolHistory(this.workspace)).slice(historyStart).find(x => x.failureKind === 'tool-execution' || x.failureKind === 'model-transport')?.failureKind ??
        (run.items.some(x => x.type === 'command_execution' && x.exit_code !== 0 && x.command.includes('author-tools') &&
          /spawn EPERM|TransformError|MODULE_NOT_FOUND/.test(x.aggregated_output)) ? 'tool-execution' : undefined);
      return { artifact, artifactHash, threadId: run.threadId, receipt, evidence, reviewEvidence, toolFailureKind, raw: run.finalResponse, requestDesignRevision: revision };
    } catch (e) { record.status = 'failed'; await this.save(); throw e; }
    finally { await stopBroker?.(); }
  }
}
