import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Design } from './design.js';
import { callModel, type ModelConfig } from './provider.js';
import { hash, saveJson } from './io.js';
import { renderPrompt } from './prompt-template.js';

const assessment = z.object({ verdict: z.enum(['pass', 'revise']), assessment: z.string().min(1) }).strict();
export const designReviewSchema = z.object({
  verdict: z.enum(['pass', 'revise']), designHash: z.string().min(1),
  issues: z.array(z.object({ severity: z.enum(['blocking', 'minor']), path: z.string().min(1),
    message: z.string().min(1), suggestedRepair: z.string().min(1) }).strict()),
  facts: assessment, mechanism: assessment, identity: assessment, revealPlan: assessment,
  limitations: z.array(z.string().min(1)).min(1),
}).strict();
export type DesignReview = z.infer<typeof designReviewSchema>;
export const designReviewPromptVersion = 'design-review-1.0';
export function designReviewAccepted(d: Design, r: DesignReview) {
  return r.designHash === hash(d) && r.verdict === 'pass' && !r.issues.some(x => x.severity === 'blocking') &&
    [r.facts, r.mechanism, r.identity, r.revealPlan].every(x => x.verdict === 'pass');
}
export async function reviewDesign(d: Design, dir: string, config: ModelConfig) {
  const template = await readFile(new URL('../prompts/review-design.md', import.meta.url), 'utf8');
  const prompt = renderPrompt(template, { version: designReviewPromptVersion, designHash: hash(d), designJson: JSON.stringify(d) });
  const raw = await callModel(prompt, z.toJSONSchema(designReviewSchema), dir, config);
  const review = designReviewSchema.parse(JSON.parse(raw));
  await saveJson(join(dir, 'review.json'), review);
  return review;
}
