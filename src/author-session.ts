import { z } from 'zod';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ThreadItem } from '@openai/codex-sdk';
import { agentOptions, createCodexClient, runLoggedThread, type AgentClient, type AgentThread } from './sdk-run.js';
import { readAuthorArtifact, toolMarker, type ToolMode, type ToolReport } from './author-tools.js';
import { hash, readJson, saveJson } from './io.js';
import type { ModelConfig } from './provider.js';

export type AuthorStage = 'design' | 'build' | 'polish' | 'repair';
const receiptSchema = z.object({ artifactPath: z.enum(['design.json', 'case.json']), summary: z.string().min(1), requestDesignRevision: z.boolean() }).strict();
export const trustedToolPath = fileURLToPath(new URL('./author-tools.ts', import.meta.url));
const loader = createRequire(import.meta.url).resolve('tsx');
function quote(value: string) { return process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`; }
export function toolCommand(workspace: string, mode: ToolMode) {
  return `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} --import ${quote(loader)} ${quote(trustedToolPath)} ${quote(resolve(workspace))} ${mode}`;
}
export function trustedValidation(items: ThreadItem[], workspace: string, mode: ToolMode, artifactHash: string): ToolReport | null {
  const normalize = (text: string) => text.replace(/\\/g, '/').toLowerCase();
  for (const item of items) {
    if (item.type !== 'command_execution' || item.exit_code !== 0 || item.status !== 'completed' ||
      !normalize(item.command).includes(normalize(trustedToolPath))) continue;
    for (const line of item.aggregated_output.split(/\r?\n/)) {
      try {
        const report = JSON.parse(line) as ToolReport;
        if (report.tool === toolMarker && report.mode === mode && report.ok &&
          normalize(resolve(report.workspace)) === normalize(resolve(workspace)) &&
          (mode === 'design' ? report.designHash : report.caseHash) === artifactHash) return report;
      } catch { /* Only the trusted JSON report line is relevant. */ }
    }
  }
  return null;
}
type StageRecord = { stage: AuthorStage; directory: string; status: string; threadId?: string; artifactHash?: string };
export type AuthorState = { version: 'sdk-author-1.0'; threadId: string | null; workspace: string; stages: StageRecord[] };

export class AuthorSession {
  private constructor(readonly output: string, readonly workspace: string, private config: ModelConfig,
    private thread: AgentThread, readonly state: AuthorState) {}
  static async open(output: string, config: ModelConfig, resume = false, client: AgentClient = createCodexClient()) {
    if (config.provider !== 'codex') throw new Error('文件作者模式需要 Codex SDK；Responses 仅支持显式兼容生成');
    const root = resolve(output), workspace = join(root, 'author'); await mkdir(workspace, { recursive: true });
    const state: AuthorState = resume ? await readJson(join(root, 'author-session.json')) as AuthorState :
      { version: 'sdk-author-1.0', threadId: null, workspace, stages: [] };
    if (state.version !== 'sdk-author-1.0' || resolve(state.workspace) !== workspace || (resume && !state.threadId))
      throw new Error('作者会话记录无效或缺少可恢复 ID');
    const options = agentOptions(config, workspace, true);
    const thread = state.threadId ? client.resumeThread(state.threadId, options) : client.startThread(options);
    const author = new AuthorSession(root, workspace, config, thread, state); await author.save(); return author;
  }
  private save() { return saveJson(join(this.output, 'author-session.json'), this.state); }
  async run(stage: AuthorStage, instructions: string, directory: string) {
    const mode: ToolMode = stage === 'design' ? 'design' : 'case';
    const artifactPath = mode === 'design' ? 'design.json' : 'case.json';
    const record: StageRecord = { stage, directory: relative(this.output, resolve(directory)), status: 'running' };
    this.state.stages.push(record); await this.save();
    const prompt = `${instructions}\n\n你是持续工作的案件作者 Agent。工作目录只含本案内容。请在此目录创建或局部编辑 ${artifactPath}，不在最终回复中重复完整案件。不要修改可信工具、程序或归档记录，不委派，不访问其他案件。\n必须真实调用以下校验命令，检查失败时在本轮继续修复文件并重跑，直到通过或说明失败原因：\n${toolCommand(this.workspace, mode)}\n` +
      (mode === 'case' ? `需要检查玩家呈现时可以运行：\n${toolCommand(this.workspace, 'replay')}\n` : '') +
      (mode === 'case' ? `若发现必须改变核心事实，先修订 design.json 并运行 ${toolCommand(this.workspace, 'design')}，返回 artifactPath=design.json、requestDesignRevision=true，应用会重新独立验收基石，不能继续绕过此验收。\n` : '') +
      '最终仅返回工作回执 JSON，artifactPath 为本轮文件名，summary 说明具体修改和检查结果；正常完成 requestDesignRevision=false。';
    try {
      const run = await runLoggedThread(this.thread, prompt, z.toJSONSchema(receiptSchema), directory, this.config, true,
        async id => { this.state.threadId = id; record.threadId = id; await this.save(); });
      const receipt = receiptSchema.parse(JSON.parse(run.finalResponse));
      const revision = mode === 'case' && receipt.requestDesignRevision;
      const expectedPath = revision ? 'design.json' : artifactPath;
      if (receipt.artifactPath !== expectedPath || (mode === 'design' && receipt.requestDesignRevision)) throw new Error('作者回执的文件与当前阶段不一致');
      const artifact = await readAuthorArtifact(this.workspace, expectedPath), artifactHash = hash(artifact);
      await saveJson(join(directory, 'artifact.json'), artifact);
      const evidence = trustedValidation(run.items, this.workspace, revision ? 'design' : mode, artifactHash);
      if (!evidence) throw new Error('没有对当前文件实际调用并通过可信校验工具，拒绝作者自述结果');
      await saveJson(join(directory, 'validation-evidence.json'), evidence);
      record.status = 'completed'; record.threadId = run.threadId; record.artifactHash = artifactHash;
      await this.save();
      return { artifact, artifactHash, threadId: run.threadId, receipt, evidence, raw: run.finalResponse, requestDesignRevision: revision };
    } catch (e) { record.status = 'failed'; await this.save(); throw e; }
  }
}
