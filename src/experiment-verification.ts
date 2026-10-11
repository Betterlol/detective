import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { caseSchema } from './model.js';
import { audit, inferenceEvidence, replay } from './validate.js';
import { hash, readJson, saveJson } from './io.js';
import { reviewAccepted, reviewSchema, reviewV2Schema } from './review.js';
import { blindTranscriptValid, playerPromptMatches, type BlindRecord, type PlayerTemplate } from './blind-player.js';
import { isolatedSdkRunValid, verifySdkProvenance } from './sdk-provenance.js';
import type { SdkManifest } from './sdk-generation.js';

export type AcceptanceManifest = {
  version?: string;
  kind: string;
  theme: string;
  status: string;
  attempts: { index: number; status: string; kind: string }[];
  acceptedAttempt: number | null;
  acceptedCaseHash: string | null;
};
export type AcceptedCaseSummary = {
  directory: string; version: '1.0' | '2.0'; theme: string; title: string; ok: boolean;
  states: number | undefined; probes: number | undefined; exhaustive: boolean | undefined; steps: number;
  blindDecisions: number; blindMistakes: number; acceptedAttempt: number | null; caseHash: string;
};

export async function verifyAcceptedExperiment(dir: string, directory: string, manifest: AcceptanceManifest, legacy: boolean) {
  const c = caseSchema.parse(await readJson(join(dir, 'case.json'))), a = audit(c);
  const storedReplay = await readJson(join(dir, 'replay.json')) as { steps: { command: Parameters<typeof replay>[1][number] }[] };
  const freshReplay = replay(c, storedReplay.steps.map(x => x.command));
  const evidenceSheet = inferenceEvidence(c, freshReplay);
  const verificationDir = c.version === '1.0' ? join(dir, 'compatibility-v2') : dir;
  await saveJson(join(verificationDir, 'inference-evidence.json'), evidenceSheet);
  const review = (c.version === '2.0' ? reviewV2Schema : reviewSchema).parse(await readJson(join(dir, 'review.json')));
  const acceptedDir = join(dir, `attempt-${manifest.acceptedAttempt}`);
  const originalReview = JSON.parse(await readFile(join(acceptedDir, 'review', 'raw.json'), 'utf8'));
  const sdk = manifest.version === 'experiment-3.0' && c.version === '2.0' ? await verifySdkProvenance(dir, manifest as SdkManifest, c) : null;
  const original = sdk ? null : JSON.parse(await readFile(join(acceptedDir, 'raw.json'), 'utf8'));
  const provenance = hash(c) === manifest.acceptedCaseHash && (sdk ? sdk.ok : hash(original) === hash(c)) && hash(review) === hash(originalReview);
  const coreTrace = (x: ReturnType<typeof replay>) => ({ ...x, steps: x.steps.map(({ playerBefore, ...step }) => step) });
  const reproducible = c.version === '1.0' ? hash(coreTrace(freshReplay)) === hash(coreTrace(storedReplay as ReturnType<typeof replay>)) : hash(freshReplay) === hash(storedReplay);
  const publicViewMigrated = hash(freshReplay) !== hash(storedReplay);
  const visiblePremises = evidenceSheet.every(x => x.premises.every(p => p.visibleBeforeReasoning) && x.prerequisites.every(p => p.presentBeforeReasoning));
  let blindReproducible = legacy;
  let blindDecisions = 0, blindMistakes = 0;
  if (c.version === '2.0') {
    let playerDir = join(acceptedDir, 'player');
    try {
      const binding = await readJson(join(dir, 'player-verification.json')) as { caseHash: string; directory: string };
      if (binding.caseHash !== hash(c) || !/^[\w-]+$/.test(binding.directory)) throw new Error('重新试玩绑定来源无效');
      playerDir = join(dir, binding.directory);
      const source = await readJson(join(playerDir, 'provenance.json')) as { caseHash: string };
      if (source.caseHash !== hash(c)) throw new Error('重新试玩案件哈希不匹配');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const playtest = await readJson(join(playerDir, 'playtest.json')) as BlindRecord & { reasoningMistakes: number };
    blindReproducible = blindTranscriptValid(c, playtest);
    blindDecisions = playtest.decisions.length; blindMistakes = playtest.reasoningMistakes;
    const originalPlaytest = await readJson(join(playerDir, 'playtest.json'));
    if (playerDir === join(acceptedDir, 'player')) blindReproducible &&= hash(originalPlaytest) === hash(await readJson(join(dir, 'playtest.json')));
    for (let n = 0; n < playtest.decisions.length; n++) {
      const call = join(playerDir, `decision-${n}`), decision = playtest.decisions[n]!;
      const prompt = await readFile(join(call, 'prompt.md'), 'utf8');
      const output = JSON.parse(await readFile(join(call, 'raw.json'), 'utf8'));
      let template: PlayerTemplate | undefined;
      try { template = await readJson(join(call, 'prompt-template.json')) as PlayerTemplate; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const request = await readJson(join(call, 'request.json')) as { promptHash?: string };
      const promptMatchesPublicInput = await playerPromptMatches(decision.input, prompt, template);
      const savedTemplateHash = (playtest as BlindRecord & { promptTemplateHash?: string }).promptTemplateHash;
      const templateBound = savedTemplateHash ? !!template && template.templateHash === savedTemplateHash : !template;
      const requestBound = request.promptHash ? request.promptHash === hash(prompt) : !template && !savedTemplateHash;
      blindReproducible &&= promptMatchesPublicInput && templateBound && requestBound && hash(output) === hash(decision.output);
      if (sdk) blindReproducible &&= await isolatedSdkRunValid(call, (manifest as SdkManifest).authorThreadId!);
    }
  }
  const passed = a.ok && freshReplay.ended && reviewAccepted(c, review) && provenance && reproducible && visiblePremises && blindReproducible && (legacy || c.version === '2.0');
  await saveJson(join(verificationDir, 'verification.json'), { ok: passed, caseHash: hash(c), provenance, sdkProvenance: sdk, reproducible, visiblePremises, publicViewMigrated, blindReproducible, audit: a });
  const problem = passed ? null : `${directory} \u91cd\u65b0\u9a8c\u6536\u5931\u8d25`;
  const caseSummary = manifest.kind === 'natural-generation' ? {
    directory, version: c.version, theme: c.theme, title: c.title, ok: passed,
    states: a.search?.states, probes: a.search?.probes, exhaustive: a.search?.exhaustive,
    steps: freshReplay.steps.length, blindDecisions, blindMistakes,
    acceptedAttempt: manifest.acceptedAttempt, caseHash: hash(c),
  } : null;
  const repaired = manifest.attempts.some(x => x.kind === 'repair' && x.status === 'accepted');
  return { problem, caseSummary, repaired };
}
