import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const providerSchema = z.enum(['codex', 'responses']);
const patchSchema = z.object({
  model: z.object({ provider: providerSchema.optional(), timeoutMs: z.number().int().positive().optional() }).strict().optional(),
  generation: z.object({
    defaultConstraints: z.string().optional(),
    maxRepairs: z.number().int().nonnegative().optional(),
    maxDesignRepairs: z.number().int().nonnegative().optional(),
    maxRepairBudget: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  workflow: z.object({
    polish: z.boolean().optional(),
    foundationReview: z.boolean().optional(),
    caseReview: z.boolean().optional(),
    blindPlaytest: z.boolean().optional(),
  }).strict().optional(),
  validation: z.object({ searchStateLimit: z.number().int().positive().optional() }).strict().optional(),
  blindPlay: z.object({
    maxDecisions: z.number().int().positive().optional(),
    maxSteps: z.number().int().positive().optional(),
    maxMistakesPerInference: z.number().int().positive().optional(),
    maxActionsPerLocation: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();

const configSchema = z.object({
  model: z.object({ provider: providerSchema, timeoutMs: z.number().int().positive() }).strict(),
  generation: z.object({
    defaultConstraints: z.string(), maxRepairs: z.number().int().nonnegative(),
    maxDesignRepairs: z.number().int().nonnegative(), maxRepairBudget: z.number().int().nonnegative(),
  }).strict(),
  workflow: z.object({ polish: z.boolean(), foundationReview: z.boolean(), caseReview: z.boolean(), blindPlaytest: z.boolean() }).strict(),
  validation: z.object({ searchStateLimit: z.number().int().positive() }).strict(),
  blindPlay: z.object({ maxDecisions: z.number().int().positive(), maxSteps: z.number().int().positive(),
    maxMistakesPerInference: z.number().int().positive(), maxActionsPerLocation: z.number().int().positive() }).strict(),
}).strict().superRefine((config, ctx) => {
  for (const key of ['maxRepairs', 'maxDesignRepairs'] as const) {
    if (config.generation[key] > config.generation.maxRepairBudget) {
      ctx.addIssue({ code: 'custom', path: ['generation', key], message: `不得大于 maxRepairBudget (${config.generation.maxRepairBudget})` });
    }
  }
});

export type DetectiveConfig = z.infer<typeof configSchema>;

export const defaultDetectiveConfig: DetectiveConfig = {
  model: { provider: 'codex', timeoutMs: 480_000 },
  generation: {
    defaultConstraints: '微型完整中文案件；至少一处公平的关键推理',
    maxRepairs: 2,
    maxDesignRepairs: 2,
    maxRepairBudget: 5,
  },
  workflow: { polish: true, foundationReview: true, caseReview: true, blindPlaytest: true },
  validation: { searchStateLimit: 100_000 },
  blindPlay: { maxDecisions: 12, maxSteps: 160, maxMistakesPerInference: 3, maxActionsPerLocation: 40 },
};

const bundledConfigPath = fileURLToPath(new URL('../detective.config.json', import.meta.url));

export async function loadDetectiveConfig(path?: string): Promise<DetectiveConfig> {
  const configPath = resolve(path ?? bundledConfigPath);
  let raw: unknown = {};
  try { raw = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path !== undefined) throw error;
  }
  const patch = patchSchema.parse(raw);
  return configSchema.parse({
    model: { ...defaultDetectiveConfig.model, ...patch.model },
    generation: { ...defaultDetectiveConfig.generation, ...patch.generation },
    workflow: { ...defaultDetectiveConfig.workflow, ...patch.workflow },
    validation: { ...defaultDetectiveConfig.validation, ...patch.validation },
    blindPlay: { ...defaultDetectiveConfig.blindPlay, ...patch.blindPlay },
  });
}
