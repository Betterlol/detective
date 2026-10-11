import type { AuthorSession } from './author-session.js';
import type { GenerationAttempt } from './generation-attempt.js';
import type { DetectiveConfig } from './config.js';
import type { ModelConfig } from './provider.js';
import type { reviewCase } from './review.js';
import type { reviewDesign } from './design-review.js';
import type { BlindRecord } from './blind-player.js';
import type { blindPlay } from './blind-player.js';

export type AuthorHandle = Pick<AuthorSession, 'workspace' | 'state'> & {
  toolDrivenReview?: boolean;
  run: (...args: Parameters<AuthorSession['run']>) => Promise<Omit<Awaited<ReturnType<AuthorSession['run']>>, 'reviewEvidence' | 'toolFailureKind'> &
    { reviewEvidence?: Awaited<ReturnType<AuthorSession['run']>>['reviewEvidence']; toolFailureKind?: string }>;
};

export type GenerationServices = {
  config: () => ModelConfig;
  openAuthor: (out: string, config: ModelConfig, resume: boolean, searchStateLimit: number) => Promise<AuthorHandle>;
  reviewDesign: typeof reviewDesign;
  reviewCase: typeof reviewCase;
  blindPlay: (c: Parameters<typeof blindPlay>[0], out: string, config: ModelConfig,
    limits: DetectiveConfig['blindPlay']) => Promise<BlindRecord & { reasoningMistakes: number }>;
};

export type SdkSource = {
  kind: 'sdk-file'; stageDirectory: string; artifactHash: string; threadId: string; designHash: string; foundationIndex: number;
};

export type FoundationAttempt = {
  index: number; sourceDirectory: string; reviewDirectory: string; status: string;
  sourceHash?: string; designHash?: string; threadId?: string; diagnostics?: unknown; consumesBudget?: boolean; reviewSkipped?: boolean;
  failureKind?: string;
};

export type SdkManifest = {
  version: 'experiment-3.0'; contentVersion: '2.0'; engine: 'codex-sdk'; theme: string; constraints: string;
  config: ModelConfig; kind: string; startedAt: string; completedAt: string | null; status: string;
  settings: DetectiveConfig; skippedMechanisms: string[];
  maxRepairs: number; maxDesignRepairs: number; foundationAttempts: FoundationAttempt[];
  acceptedDesignHash: string | null; acceptedFoundation: number | null; authorThreadId: string | null;
  pendingDesignRevision?: boolean;
  attempts: (GenerationAttempt & { source?: SdkSource; consumesBudget?: boolean })[]; acceptedAttempt: number | null; acceptedCaseHash: string | null;
};
