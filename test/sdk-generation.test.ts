import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { generateWithSdk, type GenerationServices } from '../src/sdk-generation.js';
import { fixtureDesign } from './designfixture.js';
import { fixtureV2 } from './v2fixture.js';
import { hash, readJson, saveJson } from '../src/io.js';
import { ModelCallError } from '../src/sdk-run.js';
import { checkAuthorWorkspace } from '../src/author-tools.js';
import type { AuthorStage } from '../src/author-session.js';
import type { ReviewV2 } from '../src/review.js';

async function withTemp(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'detective-sdk-generation-test-'));
  try { await run(dir); } finally { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('detective-sdk-generation-test-')); await rm(dir, { recursive: true, force: true }); }
}
function services(out: string, foundationFails = 0, caseFails = 0) {
  const stages: AuthorStage[] = [], resumed: boolean[] = []; const d = fixtureDesign(), c = fixtureV2();
  const config = { provider: 'codex' as const, model: 'test-fixture', timeoutMs: 1000 };
  let designReviews = 0, caseReviews = 0;
  const deps: GenerationServices = {
    config: () => config,
    async openAuthor(root, _config, resume) {
      resumed.push(resume); const workspace = join(root, 'author');
      await saveJson(join(root, 'author-session.json'), { version: 'sdk-author-1.0', threadId: 'author-fixture', workspace, stages: [] });
      return { workspace, state: { version: 'sdk-author-1.0', threadId: 'author-fixture', workspace, stages: [] },
        async run(stage, _prompt, dir) {
          stages.push(stage); const artifact = stage === 'design' ? d : structuredClone(c);
          if (stage === 'repair' && 'inferences' in artifact) artifact.inferences[0]!.failureText = '修复后的明确反馈';
          await saveJson(join(workspace, 'design.json'), d);
          await saveJson(join(workspace, stage === 'design' ? 'design.json' : 'case.json'), artifact);
          await saveJson(join(dir, 'artifact.json'), artifact);
          return { artifact, artifactHash: hash(artifact), threadId: 'author-fixture', receipt: { artifactPath: stage === 'design' ? 'design.json' as const : 'case.json' as const, summary: '测试阶段', requestDesignRevision: false },
            evidence: await checkAuthorWorkspace(workspace, stage === 'design' ? 'design' : 'case'), raw: '{}', requestDesignRevision: false };
        } };
    },
    async reviewDesign(design) {
      const verdict = designReviews++ < foundationFails ? 'revise' as const : 'pass' as const;
      const assessment = { verdict, assessment: '测试基石评审' };
      return { verdict, designHash: hash(design), issues: [], facts: assessment, mechanism: assessment, identity: assessment, revealPlan: assessment, limitations: ['fixture only'] };
    },
    async reviewCase(caseData) {
      assert.equal(caseData.version, '2.0'); if (caseData.version !== '2.0') throw Error('version');
      const verdict = caseReviews++ < caseFails ? 'revise' as const : 'pass' as const;
      const r: ReviewV2 = { verdict, issues: [], inferenceReviews: caseData.inferences.map(i => ({ inferenceId: i.id, claimQuote: '测试引文', evidenceQuotes: ['测试材料'],
        premiseAvailability: [{ knowledgeId: i.argument.premises[0]!.knowledgeId, acquiredAt: 0, quote: i.argument.premises[0]!.quote }], logicalAssessment: 'fixture', alternativeAssessment: 'fixture', progressionAssessment: 'fixture', verdict })),
        narrative: { motivation: 'fixture', suspense: 'fixture', reveal: 'fixture', feedback: 'fixture', limitations: 'fixture' }, limitations: ['fixture only'],
        closure: { inferenceId: caseData.resolution.identityInferenceId, actorId: caseData.truth.culpritId, actFactId: caseData.resolution.actFactId, evidenceQuotes: ['测试一', '测试二'], exclusionAssessment: 'fixture', verdict },
        questioning: { meaningfulPress: true, revisedTestimony: true, stagedReveal: true, assessment: 'fixture' }, leakage: { authorIdsVisible: false, earlyConclusion: false, choiceCue: false, assessment: 'fixture' } };
      return r;
    },
    async blindPlay() { return { ok: true, transcript: [], finalState: { locationId: 'archive', knowledge: [], evidence: [], claims: [], flags: [], completed: [], solved: [], ended: true }, decisions: [], reasoningMistakes: 0 }; },
  };
  return { deps, stages, resumed };
}

test('foundation review failure repairs the foundation before building, then case feedback repairs files', async () => withTemp(async dir => {
  const { deps, stages } = services(dir, 1, 1);
  const result = await generateWithSdk({ theme: 'test', constraints: '', out: dir, maxRepairs: 1, maxDesignRepairs: 1 }, deps);
  assert.equal(result.status, 'accepted'); assert.equal(result.foundationAttempts.length, 2);
  assert.deepEqual(stages, ['design', 'design', 'build', 'polish', 'repair']);
  assert.equal(result.attempts[0]!.status, 'review-failed'); assert.equal(result.acceptedAttempt, 1);
  assert.equal(result.authorThreadId, 'author-fixture');
  assert.equal(result.config.model, 'gpt-6-luna'); assert.equal(result.config.reasoningEffort, 'high');
}));

test('foundation budget exhaustion prevents executable case generation', async () => withTemp(async dir => {
  const { deps, stages } = services(dir, 10);
  const result = await generateWithSdk({ theme: 'test', constraints: '', out: dir, maxDesignRepairs: 0 }, deps);
  assert.equal(result.status, 'failed'); assert.deepEqual(stages, ['design']); assert.equal(result.attempts.length, 0);
}));

test('additional feedback resumes the author instead of starting another creator conversation', async () => withTemp(async dir => {
  const { deps, resumed } = services(dir);
  await generateWithSdk({ theme: 'test', constraints: '', out: dir, maxRepairs: 0 }, deps);
  const result = await generateWithSdk({ theme: '', constraints: '', out: dir, resume: true, feedback: { message: '补充反馈' }, maxRepairs: 1 }, deps);
  assert.deepEqual(resumed, [false, true]); assert.equal(result.status, 'accepted'); assert.equal(result.acceptedAttempt, 1);
}));

test('resuming a failed foundation still builds and polishes the first complete case', async () => withTemp(async dir => {
  const failed = services(dir, 10);
  await generateWithSdk({ theme: 'test', constraints: '', out: dir, maxDesignRepairs: 0 }, failed.deps);
  const next = services(dir);
  const result = await generateWithSdk({ theme: '', constraints: '', out: dir, resume: true, feedback: { message: 'repair foundation' }, maxDesignRepairs: 1 }, next.deps);
  assert.equal(result.status, 'accepted'); assert.deepEqual(next.stages, ['design', 'build', 'polish']);
}));

test('explicit foundation revision from a case stage is reviewed before continuing content', async () => withTemp(async dir => {
  const base = services(dir), original = base.deps.openAuthor; let current = fixtureDesign(), requested = false;
  base.deps.openAuthor = async (...args) => {
    const a = await original(...args), run = a.run.bind(a);
    a.run = async (stage, prompt, directory) => {
      const value = await run(stage, prompt, directory);
      if (stage === 'build' && !requested) {
        requested = true; current = { ...current, risks: [...current.risks, '显式修订测试'] };
        await saveJson(join(a.workspace, 'design.json'), current); await saveJson(join(directory, 'artifact.json'), current);
        return { ...value, artifact: current, artifactHash: hash(current), requestDesignRevision: true,
          receipt: { artifactPath: 'design.json', summary: 'request foundation revision', requestDesignRevision: true },
          evidence: await checkAuthorWorkspace(a.workspace, 'design') };
      }
      await saveJson(join(a.workspace, 'design.json'), current); return value;
    };
    return a;
  };
  const result = await generateWithSdk({ theme: 'test', constraints: '', out: dir, maxRepairs: 1 }, base.deps);
  assert.equal(result.status, 'accepted'); assert.equal(result.acceptedFoundation, 1);
  assert.equal(result.attempts[0]!.status, 'design-revision-requested'); assert.equal(result.acceptedAttempt, 1);
  assert.deepEqual(base.stages, ['design', 'build', 'repair']);
}));

test('a failed author setup stops the experiment instead of leaving a running manifest', async () => withTemp(async dir => {
  const base = services(dir); base.deps.openAuthor = async () => { throw new Error('missing runtime'); };
  const result = await generateWithSdk({ theme: 'test', constraints: '', out: dir }, base.deps);
  assert.equal(result.status, 'failed'); assert.ok(result.completedAt); assert.equal(result.attempts.length, 0);
}));

test('a rejected requested foundation revision blocks content and must be accepted on resume', async () => withTemp(async dir => {
  const base = services(dir), open = base.deps.openAuthor, review = base.deps.reviewDesign;
  let reviews = 0;
  base.deps.reviewDesign = async (...args) => {
    const result = await review(...args);
    if (reviews++ > 0) { result.verdict = 'revise'; result.identity.verdict = 'revise'; }
    return result;
  };
  base.deps.openAuthor = async (...args) => {
    const a = await open(...args), run = a.run.bind(a);
    a.run = async (stage, prompt, dir) => {
      const value = await run(stage, prompt, dir);
      if (stage !== 'build') return value;
      const design = fixtureDesign(); design.risks.push('requested revision');
      await saveJson(join(a.workspace, 'design.json'), design);
      return { ...value, artifact: design, artifactHash: hash(design), requestDesignRevision: true,
        receipt: { artifactPath: 'design.json', summary: 'revision', requestDesignRevision: true } };
    }; return a;
  };
  const failed = await generateWithSdk({ theme: 'test', constraints: '', out: dir, maxDesignRepairs: 1, maxRepairs: 2 }, base.deps);
  assert.equal(failed.status, 'failed'); assert.equal(failed.acceptedDesignHash, null);
  assert.deepEqual(base.stages, ['design', 'build']);
  const next = services(dir);
  const resumed = await generateWithSdk({ theme: '', constraints: '', out: dir, resume: true, feedback: { message: 'repair proposed foundation' }, maxDesignRepairs: 2 }, next.deps);
  assert.equal(resumed.status, 'accepted'); assert.equal(next.stages[0], 'design');
}));

for (const failingStage of ['design', 'build'] as const) test(`six ${failingStage} transport failures preserve records without consuming defect repairs`, async () => withTemp(async dir => {
  for (let n = 0; n < 6; n++) {
    const base = services(dir), open = base.deps.openAuthor;
    base.deps.openAuthor = async (...args) => {
      const a = await open(...args), run = a.run.bind(a);
      a.run = async (stage, ...args) => {
        if (stage === failingStage) throw new ModelCallError('temporary network failure');
        return run(stage, ...args);
      }; return a;
    };
    const failed = await generateWithSdk({ theme: 'test', constraints: '', out: dir, resume: n > 0,
      feedback: n > 0 ? { message: 'retry transport' } : undefined, maxDesignRepairs: 0, maxRepairs: 0 }, base.deps);
    assert.equal(failed.status, 'failed');
  }
  const next = services(dir);
  const result = await generateWithSdk({ theme: '', constraints: '', out: dir, resume: true,
    feedback: { message: 'transport restored' }, maxRepairs: 0, maxDesignRepairs: 0 }, next.deps);
  assert.equal(result.status, 'accepted');
  assert.equal(failingStage === 'design' ? result.foundationAttempts.length : result.attempts.length, 7);
}));

test('an abandoned running experiment resumes its saved author thread', async () => withTemp(async dir => {
  const base = services(dir, 10);
  await generateWithSdk({ theme: 'test', constraints: '', out: dir, maxDesignRepairs: 0 }, base.deps);
  const prior = await readJson(join(dir, 'manifest.json')) as { status: string; foundationAttempts: { status: string }[] };
  prior.status = 'running'; prior.foundationAttempts[0]!.status = 'running';
  await saveJson(join(dir, 'manifest.json'), prior);
  await saveJson(join(dir, 'generation-lock.json'), { pid: 2147483647, token: 'abandoned' });
  const next = services(dir);
  const result = await generateWithSdk({ theme: '', constraints: '', out: dir, resume: true, feedback: { message: 'recover interruption' }, maxDesignRepairs: 0 }, next.deps);
  assert.equal(result.status, 'accepted'); assert.deepEqual(next.resumed, [true]);
  assert.equal(result.foundationAttempts[0]!.status, 'interrupted');
}));

test('a live experiment lease prevents a second author from starting', async () => withTemp(async dir => {
  await saveJson(join(dir, 'generation-lock.json'), { pid: process.pid, token: 'live-owner' });
  const base = services(dir);
  await assert.rejects(generateWithSdk({ theme: 'test', constraints: '', out: dir }, base.deps), /仍在运行/);
  assert.equal(base.resumed.length, 0);
}));

test('evaluation runtime failures do not exhaust content defect repairs', async () => withTemp(async dir => {
  for (let n = 0; n < 6; n++) {
    const base = services(dir); base.deps.blindPlay = async () => { throw new Error('evaluation program unavailable'); };
    const result = await generateWithSdk({ theme: 'test', constraints: '', out: dir, resume: n > 0,
      feedback: n > 0 ? { message: 'retry evaluation' } : undefined, maxRepairs: 0 }, base.deps);
    assert.equal(result.status, 'failed');
  }
  const result = await generateWithSdk({ theme: '', constraints: '', out: dir, resume: true,
    feedback: { message: 'evaluation restored' }, maxRepairs: 0 }, services(dir).deps);
  assert.equal(result.status, 'accepted'); assert.equal(result.attempts.length, 7);
}));
