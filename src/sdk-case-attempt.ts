import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { readAuthorArtifact, auditFromEvidence } from './author-tools.js';
import { auditDesign, designConsistency } from './design-validation.js';
import { caseV2Schema } from './model.js';
import { audit } from './validate.js';
import { hash, saveJson } from './io.js';
import { changes } from './experiment-report.js';
import type { GenerationAttempt } from './generation-attempt.js';
import type { GenerateInput } from './generate.js';
import type { DetectiveConfig } from './config.js';
import type { ModelConfig } from './provider.js';
import type { AuthorHandle, FoundationAttempt, GenerationServices, SdkManifest, SdkSource } from './sdk-generation-types.js';
import { runCaseQualityGates } from './case-quality.js';
import { acceptSdkFoundation, createSdkFoundation, type SdkFoundationState } from './sdk-foundation.js';
import { usedBudget } from './sdk-generation-utils.js';
import { ModelCallError } from './sdk-run.js';
import { ContentSubmissionError } from './author-session.js';

export type SdkAttemptState = SdkFoundationState & { previous: unknown };

export type SdkCaseAttemptContext = {
  input: GenerateInput;
  out: string;
  manifest: SdkManifest;
  author: AuthorHandle;
  services: GenerationServices;
  settings: DetectiveConfig;
  config: ModelConfig;
  caseTemplate: string;
  maxDesignRepairs: number;
  designTemplate: string;
  resume: boolean;
  state: SdkAttemptState;
  save: () => Promise<void>;
};

export type SdkCaseAttemptOutcome = 'continue' | 'accepted' | 'stop';

export async function runSdkCaseAttempt(context: SdkCaseAttemptContext, index: number): Promise<SdkCaseAttemptOutcome> {
  const { input, out, manifest, author, services, settings, config, caseTemplate, state, save, resume } = context;
  let existingCase = false;
  try { await access(join(author.workspace, 'case.json')); existingCase = true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }

  const directory = `attempt-${index}`;
  const attempt: GenerationAttempt & { source?: SdkSource; consumesBudget?: boolean } = {
    index, kind: state.previous || existingCase ? 'repair' : 'create', status: 'running', diagnostics: null, consumesBudget: false,
  };
  manifest.attempts.push(attempt);
  await save();
  const currentDesign = state.design!;
  await saveJson(join(author.workspace, 'design.json'), currentDesign);
  const prompt = `${caseTemplate}\n主题：${manifest.theme}\n约束：${manifest.constraints}\n` +
    '已验收基石在 design.json；按 case.schema.json 构建案件。完整保留基石人物 ID 与姓名、实施者、候选人集合、truthFacts 的 ID 和原文，可补充与之相容的事实。\n' +
    'resolution.actFactId 必须指向原文严格等于 design.coreAct 的 truth.facts 条目；已有事实没有该原文时新增事实并引用它。\n' +
    `反馈：${JSON.stringify(state.feedback)}\n`;

  try {
    console.log(`[${input.out}] 作者 ${attempt.kind} ${directory}`);
    let stageDirectory = `${directory}/${attempt.kind === 'create' ? 'build' : 'repair'}`;
    let run = await author.run(attempt.kind === 'create' ? 'build' : 'repair', `${prompt}\n在本轮自主完成构建、文案润色及所需检查，准备完整候选后提交；不会固定追加润色轮次。`, join(out, stageDirectory));
    manifest.authorThreadId = run.threadId;

    if (run.requestDesignRevision) {
      attempt.status = 'design-revision-requested';
      attempt.diagnostics = run.receipt;
      manifest.pendingDesignRevision = true;
      manifest.acceptedDesignHash = null;
      manifest.acceptedFoundation = null;
      state.design = undefined;
      await save();
      if (usedBudget(manifest.foundationAttempts) > context.maxDesignRepairs) throw new Error('基石修订预算已耗尽');
      const foundationIndex = manifest.foundationAttempts.length;
      const record: FoundationAttempt = {
        index: foundationIndex, sourceDirectory: stageDirectory,
        reviewDirectory: `design/revision-${foundationIndex}/review`, status: 'running',
      };
      manifest.foundationAttempts.push(record);
      const foundationContext = {
        input, out, manifest, author, services, settings, config,
        designTemplate: context.designTemplate, previous: state.previous,
        maxDesignRepairs: context.maxDesignRepairs, state, save,
      };
      if (!await acceptSdkFoundation(foundationContext, run, record) && !await createSdkFoundation(foundationContext))
        throw new Error('修订后的基石没有独立验收通过');
      // Both files can be prepared in the same turn. Preserve the revised case and submit it immediately.
      try {
        const prepared = await readAuthorArtifact(author.workspace, 'case.json');
        if (!caseV2Schema.safeParse(prepared).success) return 'continue';
        run = { ...run, artifact: prepared, artifactHash: hash(prepared), evidence: null, requestDesignRevision: false };
        await saveJson(join(out, stageDirectory, 'design-artifact.json'), await readAuthorArtifact(author.workspace, 'design.json'));
        await saveJson(join(out, stageDirectory, 'case-artifact.json'), prepared);
        attempt.status = 'running';
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'continue'; throw e; }
      await save();
    }

    const current = auditDesign(await readAuthorArtifact(author.workspace, 'design.json'));
    if (!current.ok || !current.design || hash(current.design) !== manifest.acceptedDesignHash) throw new Error('作者未经重新验收修改了基石');

    const rawCase = await readAuthorArtifact(author.workspace, 'case.json');
    if (hash(rawCase) !== run.artifactHash) throw new ContentSubmissionError('提交文件与作者回执快照不一致；文件变化后必须重新提交，不能沿用旧检查');
    attempt.consumesBudget = true;
    await saveJson(join(out, directory, 'case.json'), rawCase);
    if (state.previous) await saveJson(join(out, directory, 'repair-diff.json'), {
      beforeHash: hash(state.previous), afterHash: hash(rawCase), changes: changes(state.previous, rawCase),
    });
    state.previous = rawCase;

    const parsed = caseV2Schema.safeParse(rawCase);
    const boundaryStart = Date.now();
    const reused = await auditFromEvidence(author.workspace, run.evidence, await readAuthorArtifact(author.workspace, 'design.json'), rawCase, settings.validation.searchStateLimit);
    const validation = reused ?? audit(rawCase, settings.validation.searchStateLimit);
    const consistency = parsed.success ? designConsistency(state.design!, parsed.data) : [];
    const checked = { ...validation, ok: validation.ok && consistency.length === 0, issues: [...validation.issues, ...consistency] };
    await saveJson(join(out, directory, 'audit.json'), checked);
    await saveJson(join(out, stageDirectory, 'boundary-validation.json'), { caseHash: hash(rawCase), designHash: manifest.acceptedDesignHash,
      searchStateLimit: settings.validation.searchStateLimit, reused: !!reused, elapsedMs: Date.now() - boundaryStart,
      searchCount: !reused && validation.search ? 1 : 0, auditHash: hash(checked), ok: checked.ok });
    state.feedback = { failureKind: 'content', issues: checked.issues,
      search: checked.search ? { states: checked.search.states, exhaustive: checked.search.exhaustive, counterexample: checked.search.counterexample } : null };
    if (!checked.ok || !checked.search?.replay || !parsed.success) {
      attempt.status = 'validation-failed';
      attempt.diagnostics = checked.issues;
      await save();
      return 'continue';
    }

    const caseData = parsed.data;
    const trace = checked.search.replay;
    attempt.caseHash = hash(caseData);
    attempt.source = {
      kind: 'sdk-file', stageDirectory, artifactHash: run.artifactHash, threadId: run.threadId,
      designHash: manifest.acceptedDesignHash!, foundationIndex: manifest.acceptedFoundation!,
    };
    const quality = await runCaseQualityGates({
      caseData, trace, audit: checked, attempt, attemptDirectory: join(out, directory), outputDirectory: out,
      config, settings, resume, services,
    });
    if (attempt.status === 'review-failed') state.feedback = { review: quality.review };
    else if (settings.workflow.blindPlaytest) state.feedback = { review: quality.review ?? 'skipped', playerFeedback: quality.playtest };
    else state.feedback = { review: quality.review ?? 'skipped', blindPlaytest: 'skipped' };
    if (!quality.accepted) {
      await save();
      return 'continue';
    }

    manifest.status = 'accepted';
    manifest.acceptedAttempt = index;
    manifest.acceptedCaseHash = hash(caseData);
    await save();
    return 'accepted';
  } catch (e) {
    attempt.status = manifest.pendingDesignRevision ? 'design-revision-failed' : 'author-or-evaluation-failed';
    attempt.diagnostics = String(e);
    state.feedback = { failureKind: e instanceof ModelCallError ? 'model-transport' : e instanceof ContentSubmissionError ? 'content' : 'tool-execution', error: String(e) };
    await saveJson(join(out, directory, 'failure.json'), state.feedback);
    await save();
    attempt.consumesBudget = e instanceof ContentSubmissionError;
    await save();
    return e instanceof ContentSubmissionError ? 'continue' : 'stop';
  }
}
