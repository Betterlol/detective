import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk';
import { AuthorSession, toolCommand } from '../src/author-session.js';
import { checkAuthorWorkspace } from '../src/author-tools.js';
import type { AgentClient, AgentThread } from '../src/sdk-run.js';
import { fixtureDesign } from './designfixture.js';
import { fixtureV2 } from './v2fixture.js';
import { saveJson } from '../src/io.js';

const config = { provider: 'codex' as const, model: 'test-only', timeoutMs: 1000 };
async function withTemp(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'detective-author-test-'));
  try { await run(dir); } finally { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('detective-author-test-')); await rm(dir, { recursive: true, force: true }); }
}
function fakeClient(useTool = true) {
  const starts: ThreadOptions[] = [], resumes: string[] = [], resumeOptions: ThreadOptions[] = []; let n = 0;
  function make(options: ThreadOptions): AgentThread {
    let id: string | null = null;
    return { get id() { return id; }, async runStreamed() {
      return { events: (async function* (): AsyncGenerator<ThreadEvent> {
        id = 'persistent-author'; yield { type: 'thread.started', thread_id: id };
        const root = options.workingDirectory!, mode = n++ === 0 ? 'design' : 'case';
        await saveJson(join(root, mode === 'design' ? 'design.json' : 'case.json'), mode === 'design' ? fixtureDesign() : fixtureV2());
        if (useTool) yield { type: 'item.completed', item: { type: 'command_execution', id: 'validator', command: toolCommand(root, mode),
          aggregated_output: JSON.stringify(await checkAuthorWorkspace(root, mode)), status: 'completed', exit_code: 0 } };
        yield { type: 'item.completed', item: { type: 'agent_message', id: 'receipt', text: JSON.stringify({ artifactPath: mode === 'design' ? 'design.json' : 'case.json', summary: '完成本阶段', requestDesignRevision: false }) } };
        yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
      })() };
    } };
  }
  const client: AgentClient = { startThread(o) { starts.push(o); return make(o); }, resumeThread(id, o) { resumes.push(id); resumeOptions.push(o); return make(o); } };
  return { client, starts, resumes, resumeOptions };
}

test('author edits files and validates them in one thread, then resumes the saved identity', async () => withTemp(async dir => {
  const fake = fakeClient(), a = await AuthorSession.open(dir, config, false, fake.client);
  const design = await a.run('design', 'create foundation', join(dir, 'design/attempt-0'));
  const built = await a.run('build', 'create case', join(dir, 'attempt-0/build'));
  assert.equal(design.threadId, built.threadId); assert.equal(fake.starts.length, 1);
  assert.equal(fake.starts[0]!.sandboxMode, 'workspace-write');
  assert.equal(fake.starts[0]!.model, 'gpt-6-luna'); assert.equal(fake.starts[0]!.modelReasoningEffort, 'high');
  const restored = await AuthorSession.open(dir, config, true, fake.client);
  assert.deepEqual(fake.resumes, ['persistent-author']);
  assert.equal(fake.resumeOptions[0]!.model, 'gpt-6-luna'); assert.equal(fake.resumeOptions[0]!.modelReasoningEffort, 'high');
  assert.equal(restored.workspace, a.workspace);
}));

test('authors may submit without an intermediate tool; the program retains boundary validation', async () => withTemp(async dir => {
  const fake = fakeClient(false), a = await AuthorSession.open(dir, config, false, fake.client);
  const submitted = await a.run('design', 'create', join(dir, 'design/attempt-0'));
  assert.equal(submitted.evidence, null);
}));

test('trusted case tool detects changes to the accepted foundation and returns real replay text', async () => withTemp(async dir => {
  await saveJson(join(dir, 'design.json'), fixtureDesign()); await saveJson(join(dir, 'case.json'), fixtureV2());
  assert.equal((await checkAuthorWorkspace(dir, 'case')).ok, true);
  assert.equal((await checkAuthorWorkspace(dir, 'replay')).replay?.ended, true);
  const changed = fixtureV2(); changed.truth.facts[0]!.text = '改写事实'; await saveJson(join(dir, 'case.json'), changed);
  assert.equal((await checkAuthorWorkspace(dir, 'case')).ok, false);
}));

test('the advertised validation command runs from a content directory outside the project', async () => withTemp(async dir => {
  await saveJson(join(dir, 'design.json'), fixtureDesign());
  const command = toolCommand(dir, 'design');
  const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
  const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'powershell.exe' : 'sh', args,
    { cwd: dir, windowsHide: true, timeout: 30000 });
  const report = JSON.parse(stdout.trim()); assert.equal(report.ok, true); assert.equal(report.mode, 'design');
}));
