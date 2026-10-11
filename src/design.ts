import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { callModel, type ModelConfig } from './provider.js';
import { saveJson } from './io.js';
import { join } from 'node:path';
import { renderPrompt } from './prompt-template.js';

const text = z.string().min(1);
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const designSchema = z.object({
  title: text, theme: text, coreAct: text,
  actor: z.object({ id, name: text, motive: text }).strict(),
  suspects: z.array(z.object({ id, name: text, role: text, apparentSuspicion: text, exclusionMaterial: text }).strict()).min(2).max(4),
  truthFacts: z.array(z.object({ id, text }).strict()).min(4).max(14),
  timeline: z.array(z.object({ time: text, actorId: id, location: text, text }).strict()).min(3).max(8),
  mechanism: z.object({ description: text, physicalConstraints: z.array(text).min(1), materialEvidence: z.array(text).min(2) }).strict(),
  identityArgument: z.object({ independentObservations: z.array(text).min(2), causalAttribution: text,
    excludedAlternatives: z.array(z.object({ suspectId: id, hypothesis: text, rebuttal: text, source: text }).strict()).min(1) }).strict(),
  testimonyEvolution: z.array(z.object({ characterId: id, originalClaim: text, pressedDetail: text,
    contradictionEvidence: z.array(text).min(1), revision: text, nextInvestigation: text }).strict()).min(1).max(3),
  revealPlan: z.array(z.object({ question: text, availableEvidence: z.array(text).min(1), warrantedConclusion: text, nextStep: text }).strict()).min(3).max(5),
  closure: text, risks: z.array(text).min(1),
}).strict();
export type Design = z.infer<typeof designSchema>;
export const designPromptVersion = 'truth-2.0';
export async function designCase(theme: string, constraints: string, dir: string, config: ModelConfig, source?: unknown) {
  const template = await readFile(new URL('../prompts/design-v2.md', import.meta.url), 'utf8');
  const sourceSection = source ? `已有案件（需要升级，不可照搬不完整的结案）：${JSON.stringify(source)}` : '';
  const prompt = renderPrompt(template, { version: designPromptVersion, theme, constraints, sourceSection });
  const raw = await callModel(prompt, z.toJSONSchema(designSchema), dir, config);
  const design = designSchema.parse(JSON.parse(raw));
  await saveJson(join(dir, 'design.json'), design); return design;
}
