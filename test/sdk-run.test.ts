import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import type { ThreadEvent } from '@openai/codex-sdk';
import { runLoggedThread, type AgentThread } from '../src/sdk-run.js';

async function withTemp(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'detective-sdk-test-'));
  try { await run(dir); } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('detective-sdk-test-'));
    await rm(dir, { recursive: true, force: true });
  }
}
const config = { provider: 'codex' as const, model: 'test-only', timeoutMs: 1000 };
function thread(events: ThreadEvent[]): AgentThread {
  return { id: null, async runStreamed() { return { events: (async function* () { for (const event of events) yield event; })() }; } };
}
const started: ThreadEvent = { type: 'thread.started', thread_id: 'author-thread' };
const answer: ThreadEvent = { type: 'item.completed', item: { type: 'agent_message', id: 'reply', text: '{"ok":true}' } };
const command: ThreadEvent = { type: 'item.completed', item: { type: 'command_execution', id: 'check', command: 'node trusted-check', aggregated_output: '{}', exit_code: 0, status: 'completed' } };
const completed: ThreadEvent = { type: 'turn.completed', usage: { input_tokens: 2, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } };

test('SDK logging preserves tool events, final replies and thread identity across turns', async () => withTemp(async dir => {
  const t = thread([started, command, answer, completed]); const ids: string[] = [];
  const a = await runLoggedThread(t, 'first', {}, join(dir, 'one'), config, true, id => { ids.push(id); });
  const b = await runLoggedThread(t, 'repair', {}, join(dir, 'two'), config, true);
  assert.equal(a.threadId, 'author-thread'); assert.equal(b.threadId, a.threadId);
  assert.equal(a.items.some(x => x.type === 'command_execution'), true);
  assert.deepEqual(ids, ['author-thread']);
  assert.equal(await readFile(join(dir, 'one/raw.json'), 'utf8'), '{"ok":true}');
  assert.ok((await readFile(join(dir, 'one/events.jsonl'), 'utf8')).includes('command_execution'));
}));

test('isolated reviewers reject any tool use and preserve failure diagnostics', async () => withTemp(async dir => {
  await assert.rejects(runLoggedThread(thread([started, command, answer, completed]), 'review', {}, dir, config, false), /工具/);
  const transport = JSON.parse(await readFile(join(dir, 'transport.json'), 'utf8'));
  assert.equal(transport.exitCode, 1); assert.ok(transport.error.includes('工具'));
}));

test('failed SDK turns retain partial events and the resumable thread ID', async () => withTemp(async dir => {
  await assert.rejects(runLoggedThread(thread([started, { type: 'turn.failed', error: { message: 'timeout from runtime' } }]), 'create', {}, dir, config, true), /timeout/);
  const transport = JSON.parse(await readFile(join(dir, 'transport.json'), 'utf8'));
  assert.equal(transport.threadId, 'author-thread'); assert.equal(transport.exitCode, 1);
  assert.ok((await readFile(join(dir, 'events.jsonl'), 'utf8')).includes('turn.failed'));
}));
