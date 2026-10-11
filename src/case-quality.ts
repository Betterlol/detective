import { join } from 'node:path';
import type { Case } from './model.js';
import { reviewAccepted, reviewCase } from './review.js';
import { blindPlay, type BlindRecord } from './blind-player.js';
import type { DetectiveConfig } from './config.js';
import type { ModelConfig } from './provider.js';
import type { TraceStep } from './trace.js';
import { archivePlayerBinding } from './repair-history.js';
import { inferenceEvidence } from './validate.js';
import { saveJson } from './io.js';

export type CaseQualityServices = {
  reviewCase: typeof reviewCase;
  blindPlay: (c: Case, out: string, config: ModelConfig, limits: DetectiveConfig['blindPlay']) => Promise<BlindRecord & { reasoningMistakes: number }>;
};

export const defaultCaseQualityServices: CaseQualityServices = {
  reviewCase,
  blindPlay: (c, out, config, limits) => blindPlay(c, out, config, limits.maxDecisions, undefined, limits),
};

export type CaseQualityAttempt = { index: number; status: string; diagnostics: unknown; skippedMechanisms?: string[] };

export type CaseQualityResult = {
  accepted: boolean;
  review?: Awaited<ReturnType<typeof reviewCase>>;
  playtest?: BlindRecord & { reasoningMistakes: number };
};

export async function runCaseQualityGates(input: {
  caseData: Case;
  trace: { opening: string[]; steps: TraceStep[] };
  audit: unknown;
  attempt: CaseQualityAttempt;
  attemptDirectory: string;
  outputDirectory: string;
  config: ModelConfig;
  settings: DetectiveConfig;
  resume: boolean;
  services?: CaseQualityServices;
}): Promise<CaseQualityResult> {
  const { caseData, trace, attempt, attemptDirectory, outputDirectory, config, settings } = input;
  const services = input.services ?? defaultCaseQualityServices;
  let review: Awaited<ReturnType<typeof reviewCase>> | undefined;
  if (settings.workflow.caseReview) {
    review = await services.reviewCase(caseData, trace, join(attemptDirectory, 'review'), config);
    await saveJson(join(attemptDirectory, 'review/review.json'), review);
    if (!reviewAccepted(caseData, review)) {
      attempt.status = 'review-failed';
      attempt.diagnostics = review;
      return { accepted: false, review };
    }
  } else {
    attempt.skippedMechanisms = [...(attempt.skippedMechanisms ?? []), 'caseReview'];
    await saveJson(join(attemptDirectory, 'review/skipped.json'), { mechanism: 'caseReview', reason: 'disabled-by-config' });
  }

  let playtest: BlindRecord & { reasoningMistakes: number } | undefined;
  if (settings.workflow.blindPlaytest) {
    console.log(`[${input.outputDir}] 开始盲玩家模型试玩`);
    playtest = await services.blindPlay(caseData, join(attemptDirectory, 'player'), config, settings.blindPlay);
    if (!playtest.ok) {
      attempt.status = 'player-failed';
      attempt.diagnostics = { reason: '玩家仅凭实际文本未能通关', playtest };
      return { accepted: false, review, playtest };
    }
  } else {
    attempt.skippedMechanisms = [...(attempt.skippedMechanisms ?? []), 'blindPlaytest'];
    await saveJson(join(attemptDirectory, 'player/skipped.json'), { mechanism: 'blindPlaytest', reason: 'disabled-by-config' });
  }

  await saveJson(join(outputDirectory, 'case.json'), caseData);
  await saveJson(join(outputDirectory, 'audit.json'), input.audit);
  await saveJson(join(outputDirectory, 'replay.json'), trace);
  await saveJson(join(outputDirectory, 'inference-evidence.json'), inferenceEvidence(caseData, trace));
  if (review) await saveJson(join(outputDirectory, 'review.json'), review);
  else await saveJson(join(outputDirectory, 'review-skipped.json'), { mechanism: 'caseReview', reason: 'disabled-by-config' });
  if (playtest) await saveJson(join(outputDirectory, 'playtest.json'), playtest);
  else await saveJson(join(outputDirectory, 'playtest-skipped.json'), { mechanism: 'blindPlaytest', reason: 'disabled-by-config' });
  if (input.resume) await archivePlayerBinding(outputDirectory, attempt.index);
  attempt.status = 'accepted';
  attempt.diagnostics = review?.issues ?? [];
  return { accepted: true, review, playtest };
}
