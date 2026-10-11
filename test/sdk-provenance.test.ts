import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { experimentPath, isolatedSdkRunValid } from '../src/sdk-provenance.js';
import { hash, saveJson, saveText } from '../src/io.js';

test('SDK artifact source paths cannot escape the experiment directory', () => {
  assert.equal(experimentPath('/experiment', 'attempt-0/polish'), resolve('/experiment', 'attempt-0/polish'));
  for (const path of ['../another-case', resolve('/another-case'), '']) assert.throws(() => experimentPath('/experiment', path));
});

test('isolated SDK source must bind the raw reply to an actual tool-free distinct conversation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'detective-sdk-source-test-'));
  try {
    await saveText(join(dir, 'prompt.md'), 'public input'); await saveText(join(dir, 'raw.json'), '{"verdict":"pass"}');
    await saveJson(join(dir, 'request.json'), { engine: 'codex-sdk', toolUse: false, promptHash: hash('public input') });
    await saveJson(join(dir, 'transport.json'), { threadId: 'reviewer', exitCode: 0 });
    const events = [{ type: 'thread.started', thread_id: 'reviewer' },
      { type: 'item.completed', item: { type: 'agent_message', id: 'answer', text: '{"verdict":"pass"}' } }, { type: 'turn.completed', usage: {} }];
    await saveText(join(dir, 'events.jsonl'), events.map(x => JSON.stringify(x)).join('\n'));
    assert.equal(await isolatedSdkRunValid(dir, 'author'), true);
    assert.equal(await isolatedSdkRunValid(dir, 'reviewer'), false);
    await saveText(join(dir, 'raw.json'), '{"verdict":"revise"}');
    assert.equal(await isolatedSdkRunValid(dir, 'author'), false);
    await saveText(join(dir, 'raw.json'), '{"verdict":"pass"}');
    await saveText(join(dir, 'events.jsonl'), [...events, { type: 'item.completed', item: { type: 'command_execution' } }].map(x => JSON.stringify(x)).join('\n'));
    assert.equal(await isolatedSdkRunValid(dir, 'author'), false);
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('detective-sdk-source-test-'));
    await rm(dir, { recursive: true, force: true });
  }
});
