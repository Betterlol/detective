import { access, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuthorSession } from './author-session.js';
import { readAuthorArtifact } from './author-tools.js';
import { designSchema, type Design } from './design.js';
import { auditDesign, designConsistency } from './design-validation.js';
import { designReviewAccepted, reviewDesign } from './design-review.js';
import { caseV2Schema, jsonSchema } from './model.js';
import { modelConfig, type ModelConfig } from './provider.js';
import { reviewAccepted, reviewCase } from './review.js';
import { blindPlay, type BlindRecord } from './blind-player.js';
import { audit, inferenceEvidence } from './validate.js';
import { hash, readJson, saveJson } from './io.js';
import { changes } from './experiment-report.js';
import { archivePlayerBinding, repairSource } from './repair-history.js';
import { renderPrompt } from './prompt-template.js';
import type { GenerateInput } from './generate.js';
import type { GenerationAttempt } from './generation-attempt.js';
import { ModelCallError } from './sdk-run.js';
import { acquireGenerationLease } from './generation-lease.js';

type AuthorHandle = Pick<AuthorSession, 'workspace' | 'state' | 'run'>;
export type GenerationServices = {
  config: () => ModelConfig;
  openAuthor: (out: string, config: ModelConfig, resume: boolean) => Promise<AuthorHandle>;
  reviewDesign: typeof reviewDesign;
  reviewCase: typeof reviewCase;
  blindPlay: (c: Parameters<typeof blindPlay>[0], out: string, config: ModelConfig) => Promise<BlindRecord & { reasoningMistakes: number }>;
};
const defaults: GenerationServices = { config: modelConfig, openAuthor: (out, config, resume) => AuthorSession.open(out, config, resume), reviewDesign, reviewCase, blindPlay };
export type SdkSource = { kind: 'sdk-file'; stageDirectory: string; artifactHash: string; threadId: string; designHash: string; foundationIndex: number };
export type FoundationAttempt = { index: number; sourceDirectory: string; reviewDirectory: string; status: string;
  sourceHash?: string; designHash?: string; threadId?: string; diagnostics?: unknown; consumesBudget?: boolean };
export type SdkManifest = {
  version: 'experiment-3.0'; contentVersion: '2.0'; engine: 'codex-sdk'; theme: string; constraints: string;
  config: ModelConfig; kind: string; startedAt: string; completedAt: string | null; status: string;
  maxRepairs: number; maxDesignRepairs: number; foundationAttempts: FoundationAttempt[];
  acceptedDesignHash: string | null; acceptedFoundation: number | null; authorThreadId: string | null;
  pendingDesignRevision?: boolean;
  attempts: (GenerationAttempt & { source?: SdkSource; consumesBudget?: boolean })[]; acceptedAttempt: number | null; acceptedCaseHash: string | null;
};
function budget(value: number) { if (!Number.isInteger(value) || value < 0 || value > 5) throw new Error('修复预算必须为0至5'); return value; }
async function optionalJson(path: string) {
  try { return await readJson(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return undefined; }
}
function usedBudget(records: { status: string; consumesBudget?: boolean }[]) {
  return records.filter(x => x.consumesBudget ?? !['running', 'interrupted', 'author-failed', 'author-or-evaluation-failed', 'design-revision-requested', 'design-revision-failed'].includes(x.status)).length;
}

export async function generateWithSdk(input: GenerateInput, overrides: Partial<GenerationServices> = {}): Promise<SdkManifest> {
  const out = resolve(input.out); await mkdir(out, { recursive: true });
  const release = await acquireGenerationLease(out);
  try { return await generateSdkLocked(input, overrides); }
  finally { await release(); }
}

async function generateSdkLocked(input: GenerateInput, overrides: Partial<GenerationServices>): Promise<SdkManifest> {
  const services = { ...defaults, ...overrides }, config = services.config(), out = resolve(input.out);
  let maxRepairs = budget(input.maxRepairs ?? 2), maxDesignRepairs = budget(input.maxDesignRepairs ?? 2);
  if (config.provider !== 'codex') throw new Error('SDK 作者流程要求 Codex provider');
  if (!input.resume) {
    try { await access(join(out, 'manifest.json')); throw new Error('输出目录已有实验记录，请使用新目录'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  await mkdir(out, { recursive: true });
  let manifest: SdkManifest = { version: 'experiment-3.0', contentVersion: '2.0', engine: 'codex-sdk', theme: input.theme, constraints: input.constraints,
    config, kind: input.injected ? 'injected-defect-repair' : 'natural-generation', startedAt: new Date().toISOString(), completedAt: null,
    status: 'running', maxRepairs, maxDesignRepairs, foundationAttempts: [], acceptedDesignHash: null, acceptedFoundation: null,
    authorThreadId: null, attempts: [], acceptedAttempt: null, acceptedCaseHash: null };
  let feedback: unknown = input.feedback ?? null, previous = input.source, design: Design | undefined;
  let resumeAuthor = false;
  if (input.resume) {
    const prior = await readJson(join(out, 'manifest.json')) as SdkManifest;
    if (!input.feedback) throw new Error('续修需要明确反馈');
    await saveJson(join(out, `resume-${prior.attempts.length}-${randomUUID()}.json`), { priorManifest: prior, feedback: input.feedback, config });
    // An exclusive lease has already established that no prior generator is alive.
    if (prior.status === 'running') for (const record of [...(prior.foundationAttempts ?? []), ...prior.attempts]) {
      if (record.status === 'running') { record.status = 'interrupted'; record.consumesBudget = false; }
    }
    previous = await repairSource(out, prior.attempts);
    maxRepairs = budget(input.maxRepairs ?? prior.maxRepairs);
    if (usedBudget(prior.attempts) > maxRepairs) throw new Error('已无内容修复预算，请增加 repairs');
    if (prior.version === 'experiment-3.0') {
      manifest = prior; maxDesignRepairs = budget(input.maxDesignRepairs ?? prior.maxDesignRepairs);
      const state = await optionalJson(join(out, 'author-session.json')) as { threadId?: string } | undefined;
      resumeAuthor = !!state?.threadId;
      if (manifest.acceptedDesignHash && !manifest.pendingDesignRevision) {
        const checked = auditDesign(await readJson(join(out, 'design/design.json')));
        if (!checked.ok || !checked.design || hash(checked.design) !== manifest.acceptedDesignHash) throw new Error('已验收基石发生未记录的变更');
        design = checked.design;
      }
    } else {
      // Keep the legacy authoring artifacts before migrating into a new persistent session.
      const oldDesign = await optionalJson(join(out, 'design/design.json'));
      await saveJson(join(out, `legacy-source-${randomUUID()}.json`), { design: oldDesign, case: previous, manifest: prior });
      manifest.theme = prior.theme; manifest.constraints = prior.constraints; manifest.kind = prior.kind;
      manifest.attempts = prior.attempts;
    }
    if (manifest.acceptedAttempt !== null) {
      const accepted = manifest.attempts.find(x => x.index === manifest.acceptedAttempt);
      if (accepted) { accepted.status = 'additional-review-failed'; accepted.diagnostics = feedback; }
    }
    manifest.acceptedAttempt = null; manifest.acceptedCaseHash = null; manifest.completedAt = null;
  }
  manifest.config = config; manifest.maxRepairs = maxRepairs; manifest.maxDesignRepairs = maxDesignRepairs; manifest.status = 'running';
  const save = () => saveJson(join(out, 'manifest.json'), manifest);
  await save();
  let author: AuthorHandle;
  try { author = await services.openAuthor(out, config, resumeAuthor); }
  catch (e) {
    manifest.status = 'failed'; manifest.completedAt = new Date().toISOString();
    await saveJson(join(out, 'author-start-failure.json'), { error: String(e) }); await save(); return manifest;
  }
  try {
    await saveJson(join(author.workspace, 'design.schema.json'), (await import('zod')).z.toJSONSchema(designSchema));
    await saveJson(join(author.workspace, 'case.schema.json'), jsonSchema);
    if (previous) { await saveJson(join(author.workspace, 'source-case.json'), previous); await saveJson(join(out, 'source.json'), previous); }
    const designTemplate = await readFile(new URL('../prompts/design-v2.md', import.meta.url), 'utf8');
    const caseTemplate = (await readFile(new URL('../prompts/create-v2.md', import.meta.url), 'utf8'))
      .replace('只返回 JSON，不执行工具、不改文件、不委派。', '将案件写入 case.json，使用工具检查并修复文件，不委派。');
    async function acceptFoundation(run: Awaited<ReturnType<AuthorHandle['run']>>, record: FoundationAttempt) {
      record.consumesBudget = true;
      record.sourceHash = run.artifactHash; record.threadId = run.threadId; manifest.authorThreadId = run.threadId;
      const checked = auditDesign(run.artifact); await saveJson(join(out, record.sourceDirectory, 'audit.json'), checked);
      if (!checked.ok || !checked.design) { record.status = 'validation-failed'; record.diagnostics = checked.issues; feedback = checked; return false; }
      const d = checked.design; record.designHash = hash(d);
      console.log(`[${input.out}] 基石独立逻辑验收 ${record.index}`);
      const review = await services.reviewDesign(d, join(out, record.reviewDirectory), config);
      await saveJson(join(out, record.reviewDirectory, 'review.json'), review);
      if (!designReviewAccepted(d, review)) { record.status = 'review-failed'; record.diagnostics = review; feedback = review; return false; }
      design = d; record.status = 'accepted'; manifest.acceptedFoundation = record.index; manifest.acceptedDesignHash = hash(d);
      manifest.pendingDesignRevision = false;
      await saveJson(join(out, 'design/design.json'), d); await saveJson(join(out, 'design/review.json'), review);
      await saveJson(join(author.workspace, 'design.json'), d); await save(); return true;
    }
    async function createFoundation() {
      while (usedBudget(manifest.foundationAttempts) <= maxDesignRepairs) {
        const index = manifest.foundationAttempts.length, directory = `design/attempt-${index}`;
        const record: FoundationAttempt = { index, sourceDirectory: directory, reviewDirectory: `${directory}/review`, status: 'running', consumesBudget: false };
        manifest.foundationAttempts.push(record); await save();
        try {
          console.log(`[${input.out}] 作者基石阶段 ${index}`);
          const prompt = renderPrompt(designTemplate, { version: 'truth-3.0', theme: manifest.theme, constraints: manifest.constraints,
            sourceSection: previous ? '本案既有内容在 source-case.json；设计应核对既有材料，可以明确修订不足的逻辑。' : '' })
            .replace('只创作侦探案件的设计 JSON，符合所给 Schema。中文原创。不调用工具、不改文件、不委派。',
              '在 design.json 创建或修订符合 design.schema.json 的案件基石，中文原创。使用可信工具检查并根据反馈修复，不委派。');
          const run = await author.run('design', `${prompt}\n本阶段反馈：${JSON.stringify(feedback)}`, join(out, directory));
          if (await acceptFoundation(run, record)) return true;
        } catch (e) {
          record.status = 'author-failed'; record.diagnostics = String(e); feedback = { error: String(e) };
          await saveJson(join(out, directory, 'failure.json'), feedback);
          const transport = await optionalJson(join(out, directory, 'transport.json')) as { exitCode?: number } | undefined;
          if (e instanceof ModelCallError || transport?.exitCode === 1) record.consumesBudget = false;
          await save(); return false;
        }
        await save();
      }
      return false;
    }
    if (!design && !await createFoundation()) { manifest.status = 'failed'; return manifest; }
    while (usedBudget(manifest.attempts) <= maxRepairs) {
      const n = manifest.attempts.length;
      let existingCase = false;
      try { await access(join(author.workspace, 'case.json')); existingCase = true; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const directory = `attempt-${n}`, attempt: GenerationAttempt & { source?: SdkSource; consumesBudget?: boolean } = {
        index: n, kind: previous || existingCase ? 'repair' : 'create', status: 'running', diagnostics: null, consumesBudget: false };
      manifest.attempts.push(attempt); await save();
      const currentDesign = design!; await saveJson(join(author.workspace, 'design.json'), currentDesign);
      const prompt = `${caseTemplate}\n主题：${manifest.theme}\n约束：${manifest.constraints}\n` +
        '已验收基石在 design.json；按 case.schema.json 构建案件。完整保留基石人物 ID 与姓名、实施者、候选人集合、truthFacts 的 ID 和原文，可补充与之相容的事实。\n' +
        'resolution.actFactId 必须指向原文严格等于 design.coreAct 的 truth.facts 条目；已有事实没有该原文时新增事实并引用它。\n' +
        `反馈：${JSON.stringify(feedback)}\n`;
      try {
        console.log(`[${input.out}] 作者 ${attempt.kind} ${directory}`);
        let stageDirectory = `${directory}/${attempt.kind === 'create' ? 'build' : 'repair'}`;
        let run = await author.run(attempt.kind === 'create' ? 'build' : 'repair', `${prompt}\n先完成可执行取证、条件与推理关系。`, join(out, stageDirectory));
        if (!run.requestDesignRevision && attempt.kind === 'create') {
          stageDirectory = `${directory}/polish`;
          run = await author.run('polish', `${prompt}\n可执行案件已存在。局部完善人物语气、悬念、追问、反驳与结局演出；事实和必要前提须保持一致，检查真实回放文字并重新校验。`, join(out, stageDirectory));
        }
        manifest.authorThreadId = run.threadId;
        if (run.requestDesignRevision) {
          attempt.status = 'design-revision-requested'; attempt.diagnostics = run.receipt;
          manifest.pendingDesignRevision = true; manifest.acceptedDesignHash = null; manifest.acceptedFoundation = null; design = undefined;
          await save();
          if (usedBudget(manifest.foundationAttempts) > maxDesignRepairs) throw new Error('基石修订预算已耗尽');
          const index = manifest.foundationAttempts.length, record: FoundationAttempt = { index, sourceDirectory: stageDirectory,
            reviewDirectory: `design/revision-${index}/review`, status: 'running' };
          manifest.foundationAttempts.push(record);
          if (!await acceptFoundation(run, record) && !await createFoundation())
            throw new Error('修订后的基石没有独立验收通过');
          await save(); continue;
        }
        const current = auditDesign(await readAuthorArtifact(author.workspace, 'design.json'));
        if (!current.ok || !current.design || hash(current.design) !== manifest.acceptedDesignHash) throw new Error('作者未经重新验收修改了基石');
        const rawCase = run.artifact;
        attempt.consumesBudget = true;
        await saveJson(join(out, directory, 'case.json'), rawCase);
        if (previous) await saveJson(join(out, directory, 'repair-diff.json'), { beforeHash: hash(previous), afterHash: hash(rawCase), changes: changes(previous, rawCase) });
        previous = rawCase;
        const parsed = caseV2Schema.safeParse(rawCase), validation = audit(rawCase);
        const consistency = parsed.success ? designConsistency(design!, parsed.data) : [];
        const checked = { ...validation, ok: validation.ok && consistency.length === 0, issues: [...validation.issues, ...consistency] };
        await saveJson(join(out, directory, 'audit.json'), checked); feedback = checked;
        if (!checked.ok || !checked.search?.replay || !parsed.success) { attempt.status = 'validation-failed'; attempt.diagnostics = checked.issues; await save(); continue; }
        const c = parsed.data, trace = checked.search.replay;
        attempt.caseHash = hash(c); attempt.source = { kind: 'sdk-file', stageDirectory, artifactHash: run.artifactHash,
          threadId: run.threadId, designHash: manifest.acceptedDesignHash!, foundationIndex: manifest.acceptedFoundation! };
        const review = await services.reviewCase(c, trace, join(out, directory, 'review'), config);
        await saveJson(join(out, directory, 'review/review.json'), review); feedback = { review };
        if (!reviewAccepted(c, review)) { attempt.status = 'review-failed'; attempt.diagnostics = review; await save(); continue; }
        const player = await services.blindPlay(c, join(out, directory, 'player'), config); feedback = { review, playerFeedback: player };
        if (!player.ok) { attempt.status = 'player-failed'; attempt.diagnostics = player; await save(); continue; }
        for (const [name, value] of Object.entries({ case: c, audit: checked, replay: trace, review, playtest: player, 'inference-evidence': inferenceEvidence(c, trace) }))
          await saveJson(join(out, `${name}.json`), value);
        if (input.resume) await archivePlayerBinding(out, n);
        attempt.status = 'accepted'; attempt.diagnostics = review.issues; manifest.status = 'accepted';
        manifest.acceptedAttempt = n; manifest.acceptedCaseHash = hash(c); await save(); break;
      } catch (e) {
        attempt.status = manifest.pendingDesignRevision ? 'design-revision-failed' : 'author-or-evaluation-failed'; attempt.diagnostics = String(e); feedback = { error: String(e) };
        await saveJson(join(out, directory, 'failure.json'), feedback); await save();
        const state = author.state.stages.at(-1), transport = state ? await optionalJson(join(out, state.directory, 'transport.json')) as { exitCode?: number } | undefined : undefined;
        if (e instanceof ModelCallError || transport?.exitCode === 1) attempt.consumesBudget = false;
        await save(); break;
      }
    }
    if (manifest.status !== 'accepted') manifest.status = 'failed';
    return manifest;
  } catch (e) {
    manifest.status = 'failed'; await saveJson(join(out, `failure-${randomUUID()}.json`), { error: String(e) }); return manifest;
  } finally {
    manifest.authorThreadId = author.state.threadId; manifest.completedAt = new Date().toISOString(); await save();
  }
}
