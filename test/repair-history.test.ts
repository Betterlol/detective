import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { archivePlayerBinding, repairSource } from '../src/repair-history.js';
import { saveJson, saveText } from '../src/io.js';
async function cleanup(dir: string, prefix: string) {
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.equal(basename(dir).startsWith(prefix), true);
  await rm(dir, { recursive: true, force: true });
}

test('repair recovers malformed model output or last case after a transport failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'detective-repair-test-'));
  try {
    const c = { title: '此前模型案件' }; await saveJson(join(dir, 'attempt-0', 'case.json'), c);
    assert.deepEqual(await repairSource(dir, [{ index: 0 }, { index: 1 }]), c);
    await saveText(join(dir, 'attempt-1', 'raw.json'), '{ malformed output');
    assert.equal(await repairSource(dir, [{ index: 0 }, { index: 1 }]), '{ malformed output');
    assert.equal(await repairSource(dir, []), undefined);
  } finally { await cleanup(dir, 'detective-repair-test-'); }
});

test('a changed accepted case archives the old player binding without overwriting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'detective-binding-test-'));
  try {
    const binding = { caseHash: 'old-case', directory: 'old-player' };
    await saveJson(join(dir, 'player-verification.json'), binding);
    const archive = await archivePlayerBinding(dir, 2);
    assert.deepEqual(JSON.parse(await readFile(archive!, 'utf8')), binding);
    assert.equal((await readdir(dir)).includes('player-verification.json'), false);
    assert.equal(await archivePlayerBinding(dir, 2), null);
    await saveJson(join(dir, 'player-verification.json'), { caseHash: 'next-case' });
    const second = await archivePlayerBinding(dir, 2);
    assert.notEqual(archive, second);
    assert.deepEqual(JSON.parse(await readFile(archive!, 'utf8')), binding);
  } finally { await cleanup(dir, 'detective-binding-test-'); }
});
