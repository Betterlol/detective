import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { type Case } from './model.js';
import { callModel, type ModelConfig } from './provider.js';
import { type TraceStep } from './trace.js';
import { saveJson } from './io.js';
import { join } from 'node:path';
import { renderPrompt } from './prompt-template.js';

const str = z.string().min(1);
export const reviewSchema = z.object({
  verdict: z.enum(['pass', 'revise']),
  issues: z.array(z.object({
    severity: z.enum(['blocking', 'minor']), category: z.enum(['facts', 'fairness', 'narrative']),
    path: str, message: str, evidenceQuote: str, suggestedRepair: str,
  }).strict()),
  inferenceReviews: z.array(z.object({
    inferenceId: str, claimQuote: str, evidenceQuotes: z.array(str).min(1),
    premiseAvailability: z.array(z.object({ knowledgeId: str, acquiredAt: z.number().int().min(0), quote: str }).strict()).min(1),
    logicalAssessment: str, alternativeAssessment: str, progressionAssessment: str,
    verdict: z.enum(['pass', 'revise']),
  }).strict()).min(1),
  narrative: z.object({ motivation: str, suspense: str, reveal: str, feedback: str, limitations: str }).strict(),
  limitations: z.array(str).min(1),
}).strict();
export type Review = z.infer<typeof reviewSchema>;
export const reviewV2Schema = reviewSchema.extend({
  closure: z.object({ inferenceId: str, actorId: str, actFactId: str,
    evidenceQuotes: z.array(str).min(2), exclusionAssessment: str, verdict: z.enum(['pass', 'revise']) }).strict(),
  questioning: z.object({ meaningfulPress: z.boolean(), revisedTestimony: z.boolean(), stagedReveal: z.boolean(), assessment: str }).strict(),
  leakage: z.object({ authorIdsVisible: z.boolean(), earlyConclusion: z.boolean(), choiceCue: z.boolean(), assessment: str }).strict(),
}).strict();
export type ReviewV2 = z.infer<typeof reviewV2Schema>;
export const reviewPromptVersion = 'review-2.1';

export async function reviewCase(c: Case, replay: { opening: string[]; steps: TraceStep[] }, dir: string, config: ModelConfig) {
  const templateName = c.version === '2.0' ? 'review-v2.md' : 'review-v1.md';
  const template = await readFile(new URL(`../prompts/${templateName}`, import.meta.url), 'utf8');
  const prompt = renderPrompt(template, { version: reviewPromptVersion, caseJson: JSON.stringify(c), replayJson: JSON.stringify(replay) });
  const schema = c.version === '2.0' ? reviewV2Schema : reviewSchema;
  const raw = await callModel(prompt, z.toJSONSchema(schema), dir, config);
  const review = schema.parse(JSON.parse(raw));
  await saveJson(join(dir, 'review.json'), review);
  return review;
}

export function reviewAccepted(c: Case, review: Review | ReviewV2): boolean {
  const core = review.verdict === 'pass' && !review.issues.some(x => x.severity === 'blocking') &&
    review.inferenceReviews.length === c.inferences.length &&
    c.inferences.every(i => review.inferenceReviews.filter(r => r.inferenceId === i.id && r.verdict === 'pass').length === 1);
  if (c.version !== '2.0') return core;
  if (!('closure' in review)) return false;
  return core && review.closure.verdict === 'pass' && review.closure.actorId === c.truth.culpritId &&
    review.closure.actFactId === c.resolution.actFactId && review.closure.inferenceId === c.resolution.identityInferenceId &&
    review.questioning.meaningfulPress && review.questioning.revisedTestimony && review.questioning.stagedReveal &&
    !review.leakage.authorIdsVisible && !review.leakage.earlyConclusion && !review.leakage.choiceCue;
}
