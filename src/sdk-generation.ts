import { access, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuthorSession } from './author-session.js';
import { designSchema, type Design } from './design.js';
import { jsonSchema } from './model.js';
import { modelConfig } from './provider.js';
import { reviewCase } from './review.js';
import { reviewDesign } from './design-review.js';
import { blindPlay } from './blind-player.js';
import { hash, readJson, saveJson } from './io.js';
import { repairSource } from './repair-history.js';
import type { GenerateInput } from './generate.js';
import type { AuthorHandle, GenerationServices, SdkManifest } from './sdk-generation-types.js';
import { acquireGenerationLease } from './generation-lease.js';
import { fixedModelConfig } from './model-policy.js';
import { loadDetectiveConfig } from './config.js';
import { auditDesign } from './design-validation.js';
import { renderPrompt } from './prompt-template.js';
import { createSdkFoundation } from './sdk-foundation.js';
import { runSdkCaseAttempt } from './sdk-case-attempt.js';
import { budget, optionalJson, usedBudget } from './sdk-generation-utils.js';

export type { AuthorHandle, FoundationAttempt, GenerationServices, SdkManifest, SdkSource } from './sdk-generation-types.js';

const defaults: GenerationServices = {
  config: modelConfig,
  openAuthor: (out, config, resume, searchStateLimit) => AuthorSession.open(out, config, resume, undefined, searchStateLimit),
  reviewDesign, reviewCase,
  blindPlay: (c, out, config, limits) => blindPlay(c, out, config, limits.maxDecisions, undefined, limits),
};

export async function generateWithSdk(input: GenerateInput, overrides: Partial<GenerationServices> = {}): Promise<SdkManifest> {
  const out = resolve(input.out);
  await mkdir(out, { recursive: true });
  const release = await acquireGenerationLease(out);
  try { return await generateSdkLocked(input, overrides); }
  finally { await release(); }
}

async function generateSdkLocked(input: GenerateInput, overrides: Partial<GenerationServices>): Promise<SdkManifest> {
  const services = { ...defaults, ...overrides };
  const settings = input.settings ?? await loadDetectiveConfig();
  const config = fixedModelConfig(overrides.config ? services.config() : modelConfig(settings));
  const out = resolve(input.out);
  let maxRepairs = budget(input.maxRepairs ?? settings.generation.maxRepairs, settings.generation.maxRepairBudget);
  let maxDesignRepairs = budget(input.maxDesignRepairs ?? settings.generation.maxDesignRepairs, settings.generation.maxRepairBudget);
  if (config.provider !== 'codex') throw new Error('SDK 作者流程要求 Codex provider');
  if (!input.resume) {
    try { await access(join(out, 'manifest.json')); throw new Error('输出目录已有实验记录，请使用新目录'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  await mkdir(out, { recursive: true });
  let manifest: SdkManifest = {
    version: 'experiment-3.0', contentVersion: '2.0', engine: 'codex-sdk', theme: input.theme, constraints: input.constraints,
    config, settings, skippedMechanisms: [], kind: input.injected ? 'injected-defect-repair' : 'natural-generation',
    startedAt: new Date().toISOString(), completedAt: null, status: 'running', maxRepairs, maxDesignRepairs,
    foundationAttempts: [], acceptedDesignHash: null, acceptedFoundation: null, authorThreadId: null,
    attempts: [], acceptedAttempt: null, acceptedCaseHash: null,
  };
  const state: { feedback: unknown; previous: unknown; design?: Design } = { feedback: input.feedback ?? null, previous: input.source };
  let resumeAuthor = false;
  if (input.resume) {
    const prior = await readJson(join(out, 'manifest.json')) as SdkManifest;
    if (!input.feedback) throw new Error('续修需要明确反馈');
    await saveJson(join(out, `resume-${prior.attempts.length}-${randomUUID()}.json`), { priorManifest: prior, feedback: input.feedback, config });
    // An exclusive lease has already established that no prior generator is alive.
    if (prior.status === 'running') for (const record of [...(prior.foundationAttempts ?? []), ...prior.attempts]) {
      if (record.status === 'running') { record.status = 'interrupted'; record.consumesBudget = false; }
    }
    state.previous = await repairSource(out, prior.attempts);
    maxRepairs = budget(input.maxRepairs ?? prior.maxRepairs, settings.generation.maxRepairBudget);
    if (usedBudget(prior.attempts) > maxRepairs) throw new Error('已无内容修复预算，请增加 repairs');
    if (prior.version === 'experiment-3.0') {
      manifest = prior;
      maxDesignRepairs = budget(input.maxDesignRepairs ?? prior.maxDesignRepairs, settings.generation.maxRepairBudget);
      for (const foundation of manifest.foundationAttempts) if (foundation.reviewSkipped === undefined)
        foundation.reviewSkipped = !(await optionalJson(join(out, foundation.reviewDirectory, 'review.json')));
      const authorState = await optionalJson(join(out, 'author-session.json')) as { threadId?: string } | undefined;
      resumeAuthor = !!authorState?.threadId;
      if (manifest.acceptedDesignHash && !manifest.pendingDesignRevision) {
        const checked = auditDesign(await readJson(join(out, 'design/design.json')));
        if (!checked.ok || !checked.design || hash(checked.design) !== manifest.acceptedDesignHash) throw new Error('已验收基石发生未记录的变更');

        state.design = checked.design;
      }
    } else {
      // Preserve legacy authoring artifacts before migrating into a persistent SDK session.
      const oldDesign = await optionalJson(join(out, 'design/design.json'));
      await saveJson(join(out, `legacy-source-${randomUUID()}.json`), { design: oldDesign, case: state.previous, manifest: prior });
      manifest.theme = prior.theme;
      manifest.constraints = prior.constraints;
      manifest.kind = prior.kind;
      manifest.attempts = prior.attempts;
    }
    if (manifest.acceptedAttempt !== null) {
      const accepted = manifest.attempts.find(x => x.index === manifest.acceptedAttempt);
      if (accepted) { accepted.status = 'additional-review-failed'; accepted.diagnostics = input.feedback; }
    }
    manifest.acceptedAttempt = null;
    manifest.acceptedCaseHash = null;
    manifest.completedAt = null;
  }

  manifest.config = config;
  manifest.settings = settings;
  manifest.maxRepairs = maxRepairs;
  manifest.maxDesignRepairs = maxDesignRepairs;
  manifest.skippedMechanisms = [
    ...(!settings.workflow.foundationReview ? ['foundationReview'] : []),
    ...(!settings.workflow.caseReview ? ['caseReview'] : []),
    ...(!settings.workflow.blindPlaytest ? ['blindPlaytest'] : []),
  ];
  manifest.status = 'running';
  const save = () => saveJson(join(out, 'manifest.json'), manifest);
  await save();

  let author: AuthorHandle;
  try { author = await services.openAuthor(out, config, resumeAuthor, settings.validation.searchStateLimit); }
  catch (e) {
    manifest.status = 'failed';
    manifest.completedAt = new Date().toISOString();
    await saveJson(join(out, 'author-start-failure.json'), { error: String(e) });
    await save();
    return manifest;
  }

  try {
    await saveJson(join(author.workspace, 'design.schema.json'), (await import('zod')).z.toJSONSchema(designSchema));
    await saveJson(join(author.workspace, 'case.schema.json'), jsonSchema);
    if (state.previous) {
      await saveJson(join(author.workspace, 'source-case.json'), state.previous);
      await saveJson(join(out, 'source.json'), state.previous);
    }
    const designTemplate = await readFile(new URL('../prompts/design-v2.md', import.meta.url), 'utf8');
    const caseTemplate = (await readFile(new URL('../prompts/create-v2.md', import.meta.url), 'utf8'))
      .replace('只返回 JSON，不执行工具、不改文件、不委派。', '将案件写入 case.json，使用工具检查并修复文件，不委派。');
    const foundationContext = {
      input, out, manifest, author, services, settings, config, designTemplate,
      previous: state.previous, maxDesignRepairs, state, save,
    };
    if (!state.design && !await createSdkFoundation(foundationContext)) {
      manifest.status = 'failed';
      return manifest;
    }

    while (usedBudget(manifest.attempts) <= maxRepairs) {
      const outcome = await runSdkCaseAttempt({
        input, out, manifest, author, services, settings, config, caseTemplate, maxDesignRepairs,
        designTemplate, resume: input.resume ?? false, state, save,
      }, manifest.attempts.length);
      if (outcome !== 'continue') break;
    }
    if (manifest.status !== 'accepted') manifest.status = 'failed';
    return manifest;
  } catch (e) {
    manifest.status = 'failed';
    await saveJson(join(out, `failure-${randomUUID()}.json`), { error: String(e) });
    return manifest;
  } finally {
    manifest.authorThreadId = author.state.threadId;
    manifest.completedAt = new Date().toISOString();
    await save();
  }
}
