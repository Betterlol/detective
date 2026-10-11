import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callModel, modelConfig } from '../src/provider.js';
import { agentOptions, removeTempDirectory, runLoggedThread, type AgentThread } from '../src/sdk-run.js';

const conflicting = { provider: 'codex' as const, model: 'gpt-6.1-sol', reasoningEffort: 'low' as const, timeoutMs: 1000 };
async function withTemp(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'detective-model-policy-test-'));
  try { await run(dir); } finally { await removeTempDirectory(dir, tmpdir(), 'detective-model-policy-test-'); }
}

test('environment overrides cannot change the required model or high reasoning effort', () => {
  const saved = { model: process.env.DETECTIVE_MODEL, effort: process.env.DETECTIVE_REASONING_EFFORT };
  try {
    process.env.DETECTIVE_MODEL = conflicting.model; process.env.DETECTIVE_REASONING_EFFORT = 'medium';
    assert.equal(modelConfig().model, 'gpt-6-luna'); assert.equal(modelConfig().reasoningEffort, 'high');
  } finally {
    if (saved.model === undefined) delete process.env.DETECTIVE_MODEL; else process.env.DETECTIVE_MODEL = saved.model;
    if (saved.effort === undefined) delete process.env.DETECTIVE_REASONING_EFFORT; else process.env.DETECTIVE_REASONING_EFFORT = saved.effort;
  }
});

test('both writer and isolated SDK threads enforce luna high for explicitly conflicting configs', () => {
  for (const author of [true, false]) {
    const options = agentOptions(conflicting, '.', author);
    assert.equal(options.model, 'gpt-6-luna'); assert.equal(options.modelReasoningEffort, 'high');
    assert.equal(options.sandboxMode, author ? 'workspace-write' : 'read-only');
  }
});

test('SDK request and transport records contain the effective fixed model config', async () => withTemp(async dir => {
  const t: AgentThread = { id: null, async runStreamed() { return { events: (async function* () {
    yield { type: 'thread.started' as const, thread_id: 'fixture' };
    yield { type: 'item.completed' as const, item: { id: 'reply', type: 'agent_message' as const, text: '{"ok":true}' } };
    yield { type: 'turn.completed' as const, usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
  })() }; } };
  await runLoggedThread(t, 'fixture only', {}, dir, conflicting, false);
  const request = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8'));
  const transport = JSON.parse(await readFile(join(dir, 'transport.json'), 'utf8'));
  assert.equal(request.model, 'gpt-6-luna'); assert.equal(request.reasoningEffort, 'high');
  assert.equal(transport.model, 'gpt-6-luna');
}));

test('Responses compatibility requests also use luna high and record the effective config', async () => withTemp(async dir => {
  const priorFetch = globalThis.fetch, priorKey = process.env.OPENAI_API_KEY;
  let payload: Record<string, unknown> | undefined;
  try {
    process.env.OPENAI_API_KEY = 'software-fixture-key';
    globalThis.fetch = async (_url, options) => {
      payload = JSON.parse(String(options?.body));
      return new Response(JSON.stringify({ id: 'fixture-response', model: 'gpt-6-luna', usage: {},
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] }), { status: 200 });
    };
    assert.equal(await callModel('fixture only', {}, dir, { ...conflicting, provider: 'responses' }), '{"ok":true}');
    assert.equal(payload?.model, 'gpt-6-luna'); assert.deepEqual(payload?.reasoning, { effort: 'high' });
    const request = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8'));
    assert.equal(request.model, 'gpt-6-luna'); assert.equal(request.reasoningEffort, 'high');
  } finally {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
  }
}));
