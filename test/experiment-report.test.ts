import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { experimentReport } from '../src/experiment-report.js';
import { saveJson, saveText } from '../src/io.js';
import { removeTempDirectory } from '../src/sdk-run.js';

test('phase counters include SDK foundation and file editing stages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'detective-report-test-'));
  try {
    for (const path of ['design/attempt-0', 'design/attempt-0/review', 'attempt-0/build', 'attempt-0/polish', 'attempt-1/repair', 'attempt-1/player/decision-0']) {
      await saveJson(join(root, 'case', path, 'request.json'), { model: 'fixture', promptHash: 'fixture' });
      await saveText(join(root, 'case', path, 'prompt.md'), 'fixture');
      await saveText(join(root, 'case', path, 'events.jsonl'), '');
    }
    const result = await experimentReport(root);
    assert.deepEqual(result.phases, { design: 1, content: 3, review: 1, player: 1 });
  } finally { await removeTempDirectory(root, tmpdir(), 'detective-report-test-'); }
});

test('offline verification and mutation searches stay separate from author tool metrics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'detective-report-test-'));
  try {
    await saveJson(join(root, 'case', 'manifest.json'), { status: 'failed', attempts: [] });
    await saveJson(join(root, 'case', 'verification.json'), { auditMetrics: { elapsedMs: 12, searchCount: 1 } });
    await saveJson(join(root, 'regression', 'case', 'mutations.json'), {
      results: [{ auditMetrics: { elapsedMs: 8, searchCount: 1 } }, { auditMetrics: { elapsedMs: 2, searchCount: 0 } }],
    });
    const result = await experimentReport(root);
    assert.equal(result.experiments[0]!.metrics.searches, 0);
    assert.equal(result.experiments[0]!.metrics.verificationSearches, 2);
    assert.equal(result.experiments[0]!.metrics.verificationMs, 22);
  } finally { await removeTempDirectory(root, tmpdir(), 'detective-report-test-'); }
});
