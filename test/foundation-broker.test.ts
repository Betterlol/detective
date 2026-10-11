import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFoundationBroker, requestFoundationReview, foundationReviewKey } from '../src/foundation-broker.js';
import { defaultDetectiveConfig } from '../src/config.js';
import { fixtureDesign } from './designfixture.js';
import { hash, saveJson } from '../src/io.js';
import { removeTempDirectory } from '../src/sdk-run.js';

test('file broker returns isolated review feedback, reuses an identical design, and bounds new evaluations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'detective-broker-test-'));
  let calls = 0;
  const settings = { ...defaultDetectiveConfig, model: { ...defaultDetectiveConfig.model, timeoutMs: 2000 } };
  const stop = startFoundationBroker(dir, settings, 1, async (d, out, config) => {
    calls++; assert.equal(config.model, 'gpt-6-luna'); assert.equal(config.reasoningEffort, 'high');
    const assessment = { verdict: 'pass' as const, assessment: 'fixture, no real model' };
    const review = { verdict: 'pass' as const, designHash: hash(d), issues: [],
      facts: assessment, mechanism: assessment, identity: assessment, revealPlan: assessment, limitations: ['fixture only'] };
    await saveJson(join(out, 'review.json'), review); return review;
  });
  try {
    const d = fixtureDesign();
    assert.equal((await requestFoundationReview(dir, d, settings)).verdict, 'pass');
    assert.equal((await requestFoundationReview(dir, d, settings)).verdict, 'pass');
    assert.equal(calls, 1);
    d.risks.push('different design');
    await assert.rejects(requestFoundationReview(dir, d, settings), /预算已耗尽/);
    assert.equal(calls, 1);
  } finally { await stop(); await removeTempDirectory(dir, tmpdir(), 'detective-broker-test-'); }
});

test('a stale failed response cannot poison an explicit retry, and old requests do not run by themselves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'detective-broker-test-'));
  const settings = { ...defaultDetectiveConfig, model: { ...defaultDetectiveConfig.model, timeoutMs: 2000 } };
  const d = fixtureDesign(), key = await foundationReviewKey(hash(d), settings);
  await saveJson(join(dir, '.detective-tools/review-requests', key + '.json'), { design: d, key, requestId: 'old', createdAt: 0 });
  await saveJson(join(dir, '.detective-tools/review-responses', key + '.json'), { requestId: 'old', error: 'old failure' });
  let calls = 0;
  const stop = startFoundationBroker(dir, settings, 2, async (design, out) => {
    calls++;
    if (calls === 1) throw new Error('temporary tool failure');
    const assessment = { verdict: 'pass' as const, assessment: 'fixture' };
    const review = { verdict: 'pass' as const, designHash: hash(design), issues: [], facts: assessment,
      mechanism: assessment, identity: assessment, revealPlan: assessment, limitations: ['fixture'] };
    await saveJson(join(out, 'review.json'), review); return review;
  });
  try {
    await new Promise(r => setTimeout(r, 250)); assert.equal(calls, 0);
    await assert.rejects(requestFoundationReview(dir, d, settings), /temporary tool failure/);
    assert.equal((await requestFoundationReview(dir, d, settings)).verdict, 'pass');
    assert.equal(calls, 2);
  } finally { await stop(); await removeTempDirectory(dir, tmpdir(), 'detective-broker-test-'); }
});
