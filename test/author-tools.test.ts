import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditFromEvidence, checkAuthorWorkspace } from '../src/author-tools.js';
import { saveJson } from '../src/io.js';
import { fixtureDesign } from './designfixture.js';
import { fixtureV2 } from './v2fixture.js';
import { removeTempDirectory } from '../src/sdk-run.js';
import { defaultDetectiveConfig } from '../src/config.js';

test('quick performs no search; replay reuses full search; edits and parameter changes invalidate it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'detective-tools-test-'));
  try {
    const d = fixtureDesign(), c = fixtureV2();
    await saveJson(join(root, 'design.json'), d); await saveJson(join(root, 'case.json'), c);
    const quick = await checkAuthorWorkspace(root, 'quick');
    assert.equal(quick.ok, true); assert.equal(quick.searchCount, 0);
    const full = await checkAuthorWorkspace(root, 'case');
    assert.equal(full.searchCount, 1); assert.ok(await auditFromEvidence(root, full, d, c, 100000));
    const replay = await checkAuthorWorkspace(root, 'replay');
    assert.equal(replay.searchCount, 0); assert.equal(replay.cacheHit, true); assert.equal(replay.replay?.ended, true);
    assert.equal(await auditFromEvidence(root, full, d, c, 100001), null);
    c.actions[0]!.repeatText += '已查看。'; await saveJson(join(root, 'case.json'), c);
    assert.equal(await auditFromEvidence(root, full, d, c, 100000), null);
    assert.equal((await checkAuthorWorkspace(root, 'replay')).searchCount, 1);
    d.risks.push('范围说明变化'); await saveJson(join(root, 'design.json'), d);
    assert.equal((await checkAuthorWorkspace(root, 'case')).searchCount, 1);
  } finally { await removeTempDirectory(root, tmpdir(), 'detective-tools-test-'); }
});

test('cached success cannot accept critical defects introduced after the last check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'detective-tools-test-'));
  try {
    const d = fixtureDesign(), c = fixtureV2();
    await saveJson(join(root, 'design.json'), d); await saveJson(join(root, 'case.json'), c);
    const full = await checkAuthorWorkspace(root, 'case');
    c.actions[0]!.effects.push({ kind: 'knowledge', id: c.inferences[0]!.conclusionKnowledgeId });
    await saveJson(join(root, 'case.json'), c);
    assert.equal(await auditFromEvidence(root, full, d, c, 100000), null);
    const checked = await checkAuthorWorkspace(root, 'case');
    assert.equal(checked.ok, false); assert.ok(checked.issues.some(x => x.code === 'bypass'));
  } finally { await removeTempDirectory(root, tmpdir(), 'detective-tools-test-'); }
});

test('disabled foundation review returns a structured skip without a model call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'detective-tools-test-'));
  try {
    await saveJson(join(root, 'manifest.json'), { settings: { ...defaultDetectiveConfig,
      workflow: { polish: true, foundationReview: false, caseReview: false, blindPlaytest: false } } });
    await saveJson(join(root, 'author/design.json'), fixtureDesign());
    const result = await checkAuthorWorkspace(join(root, 'author'), 'foundation-review');
    assert.equal(result.ok, true); assert.equal(result.skipped, true); assert.equal(result.review, undefined);
  } finally { await removeTempDirectory(root, tmpdir(), 'detective-tools-test-'); }
});

test('quick reports a repeated longest-answer cue without launching state search', async () => {
  const root = await mkdtemp(join(tmpdir(), 'detective-tools-test-'));
  try {
    const c = fixtureV2();
    for (const i of c.inferences) for (const option of i.options)
      option.text = i.solutions.some(s => s.optionId === option.id) ? '较长的完整论证内容'.repeat(5) : '另一条有据但错误的论证'.repeat(3);
    await saveJson(join(root, 'design.json'), fixtureDesign()); await saveJson(join(root, 'case.json'), c);
    const report = await checkAuthorWorkspace(root, 'quick');
    assert.equal(report.searchCount, 0);
    assert.ok(report.issues.some(x => x.code === 'consistent-option-length-cue' && x.severity === 'warning'));
  } finally { await removeTempDirectory(root, tmpdir(), 'detective-tools-test-'); }
});
