import { join } from 'node:path';
import type { Design } from './design.js';
import { auditDesign } from './design-validation.js';
import { designReviewAccepted } from './design-review.js';
import { hash, saveJson, readJson } from './io.js';
import { isolatedSdkRunValid } from './sdk-provenance.js';
import { renderPrompt } from './prompt-template.js';
import type { GenerateInput } from './generate.js';
import type { DetectiveConfig } from './config.js';
import type { ModelConfig } from './provider.js';
import type { AuthorHandle, FoundationAttempt, GenerationServices, SdkManifest } from './sdk-generation-types.js';
import { usedBudget } from './sdk-generation-utils.js';
import { ModelCallError } from './sdk-run.js';
import { ContentSubmissionError } from './author-session.js';
import { foundationReviewKey } from './foundation-broker.js';
import { readFile } from 'node:fs/promises';
import { renderPrompt as renderReviewPrompt } from './prompt-template.js';
import { designReviewPromptVersion } from './design-review.js';

export type SdkFoundationState = { feedback: unknown; design?: Design };

export type SdkFoundationContext = {
  input: GenerateInput;
  out: string;
  manifest: SdkManifest;
  author: AuthorHandle;
  services: GenerationServices;
  settings: DetectiveConfig;
  config: ModelConfig;
  designTemplate: string;
  previous: unknown;
  maxDesignRepairs: number;
  state: SdkFoundationState;
  save: () => Promise<void>;
};

type FoundationRun = Awaited<ReturnType<AuthorHandle['run']>>;

export async function acceptSdkFoundation(context: SdkFoundationContext, run: FoundationRun, record: FoundationAttempt) {
  const { input, out, manifest, author, services, settings, config, save, state } = context;
  record.consumesBudget = true;
  record.sourceHash = run.artifactHash;
  record.threadId = run.threadId;
  manifest.authorThreadId = run.threadId;
  const checked = auditDesign(run.artifact);
  await saveJson(join(out, record.sourceDirectory, 'audit.json'), checked);
  if (!checked.ok || !checked.design) {
    record.status = 'validation-failed';
    record.diagnostics = checked.issues;
    state.feedback = checked;
    return false;
  }

  const design = checked.design;
  record.designHash = hash(design);
      console.log(`[${input.out}] 基石独立逻辑验收 ${record.index}`);
  let review: Awaited<ReturnType<GenerationServices['reviewDesign']>> | undefined;
  if (settings.workflow.foundationReview) {
    record.reviewSkipped = false;
    if (author.toolDrivenReview) {
      const evidence = run.reviewEvidence;
      if (!evidence || evidence.designHash !== hash(run.artifact) || !evidence.reviewDirectory || !evidence.review) {
        if (run.toolFailureKind) { record.failureKind = run.toolFailureKind; record.consumesBudget = false; }
        record.status = 'review-not-requested'; record.diagnostics = { message: '请通过 foundation-review 工具主动提交当前设计评审；没有当前版本的通过记录。' };
        state.feedback = record.diagnostics; return false;
      }
      record.reviewDirectory = `author/${evidence.reviewDirectory.replace(/\\/g, '/')}`;
      const expectedDirectory = `author/.detective-tools/reviews/${await foundationReviewKey(hash(run.artifact), settings)}`;
      if (record.reviewDirectory !== expectedDirectory) throw new Error('设计评审缓存与当前模型、提示或配置不匹配');
      review = await readJson(join(out, record.reviewDirectory, 'review.json')) as typeof evidence.review;
      const request = await readJson(join(out, record.reviewDirectory, 'request.json')) as { model: string; reasoningEffort: string; promptHash: string };
      const template = await readFile(new URL('../prompts/review-design.md', import.meta.url), 'utf8');
      const expectedPrompt = renderReviewPrompt(template, { version: designReviewPromptVersion, designHash: hash(design), designJson: JSON.stringify(design) });
      if (request.model !== config.model || request.reasoningEffort !== config.reasoningEffort || request.promptHash !== hash(expectedPrompt))
        throw new Error('设计评审请求与当前设计及固定模型配置不匹配');
      if (hash(review) !== hash(evidence.review) || !await isolatedSdkRunValid(join(out, record.reviewDirectory), run.threadId))
        throw new Error('设计评审工具来源无效');
    } else review = await services.reviewDesign(design, join(out, record.reviewDirectory), config);
    await saveJson(join(out, record.reviewDirectory, 'review.json'), review);
    if (!designReviewAccepted(design, review)) {
      record.status = 'review-failed';
      record.diagnostics = review;
      state.feedback = review;
      return false;
    }
  } else {
    record.reviewSkipped = true;
    await saveJson(join(out, record.reviewDirectory, 'skipped.json'), { mechanism: 'foundationReview', reason: 'disabled-by-config' });
  }

  state.design = design;
  record.status = 'accepted';
  manifest.acceptedFoundation = record.index;
  manifest.acceptedDesignHash = hash(design);
  manifest.pendingDesignRevision = false;
  await saveJson(join(out, 'design/design.json'), design);
  if (review) await saveJson(join(out, 'design/review.json'), review);
  else await saveJson(join(out, 'design/review-skipped.json'), { mechanism: 'foundationReview', reason: 'disabled-by-config' });
  await saveJson(join(author.workspace, 'design.json'), design);
  await save();
  return true;
}

export async function createSdkFoundation(context: SdkFoundationContext) {
  const { input, out, manifest, author, designTemplate, previous, maxDesignRepairs, save, state } = context;
  while (usedBudget(manifest.foundationAttempts) <= maxDesignRepairs) {
    const index = manifest.foundationAttempts.length;
    const directory = `design/attempt-${index}`;
    const record: FoundationAttempt = {
      index, sourceDirectory: directory, reviewDirectory: `${directory}/review`, status: 'running', consumesBudget: false,
    };
    manifest.foundationAttempts.push(record);
    await save();
    try {
      console.log(`[${input.out}] 作者基石阶段 ${index}`);
      const prompt = renderPrompt(designTemplate, {
        version: 'truth-3.0', theme: manifest.theme, constraints: manifest.constraints,
        sourceSection: previous ? '本案既有内容在 source-case.json；设计应核对既有材料，可以明确修订不足的逻辑。' : '' })
        .replace('只创作侦探案件的设计 JSON，符合所给 Schema。中文原创。不调用工具、不改文件、不委派。',
        '在 design.json 创建或修订符合 design.schema.json 的案件基石，中文原创。使用可信工具检查并根据反馈修复，不委派。');
      const run = await author.run('design', `${prompt}\n本阶段反馈：${JSON.stringify(state.feedback)}`, join(out, directory));
      if (await acceptSdkFoundation(context, run, record)) return true;
      if (record.failureKind && record.failureKind !== 'content') return false;
    } catch (e) {
      record.status = 'author-failed';
      record.diagnostics = String(e);
      state.feedback = { failureKind: e instanceof ModelCallError ? 'model-transport' : e instanceof ContentSubmissionError ? 'content' : 'tool-execution', error: String(e) };
      await saveJson(join(out, directory, 'failure.json'), state.feedback);
      record.consumesBudget = e instanceof ContentSubmissionError;
      record.failureKind = e instanceof ModelCallError ? 'model-transport' : e instanceof ContentSubmissionError ? 'content' : 'tool-execution';
      await save();
      if (!(e instanceof ContentSubmissionError)) return false;
    }
    await save();
  }
  return false;
}
