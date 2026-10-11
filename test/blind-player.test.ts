import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureV2 } from './v2fixture.js';
import { initialState, playerView, transition } from '../src/engine.js';
import { blindPlay, blindTranscriptValid, playerPacket, playerPrompt, type BlindRecord, type PublicEvent } from '../src/blind-player.js';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempDirectory } from '../src/sdk-run.js';
import { audit } from '../src/validate.js';
import { orderedOptions, publicId } from '../src/public.js';

test('blind player receives only public observations and a frozen transcript prefix', () => {
  const c = fixtureV2(), events = [{ command: { kind: 'act', id: 'a1' }, status: 'unavailable', ok: false, text: ['不能执行'] }];
  const packet = playerPacket(c, initialState(c), events);
  events.push({ command: { kind: 'move', id: 'l2' }, status: 'advanced', ok: true, text: ['未来输出'] });
  assert.equal(packet.transcript.length, 1);
  const text = JSON.stringify(packet);
  for (const hidden of ['SECRET_', 'privateMotive', 'solutions', 'attribution', 'culpritId', 'f_act', 'future']) assert.equal(text.includes(hidden), false);
});

test('blind prompts target public IDs and verification binds each decision to its past-only input', async () => {
  const c = fixtureV2(), transcript: PublicEvent[] = [], decisions: BlindRecord['decisions'] = [];
  let state = initialState(c);
  let promptChecked = false;
  for (const step of audit(c).search!.replay!.steps) {
    const cmd = step.command;
    const input = playerPacket(c, state, transcript);
    const command = cmd.kind === 'move' ? { kind: cmd.kind, id: publicId(c, 'locations', cmd.id) } :
      cmd.kind === 'act' ? { kind: cmd.kind, id: publicId(c, 'actions', cmd.id) } :
      cmd.kind === 'press' ? { kind: cmd.kind, id: publicId(c, 'claims', cmd.id) } : {
        kind: cmd.kind, id: publicId(c, 'inferences', cmd.id),
        optionId: orderedOptions(c, c.inferences.find(i => i.id === cmd.id)!).find(x => x.internalId === cmd.optionId)!.choice,
        evidenceIds: cmd.evidenceIds.map(e => publicId(c, 'evidence', e)),
        ...(cmd.kind === 'present' ? { claimId: publicId(c, 'claims', cmd.claimId) } : {}),
      };
    const r = transition(c, state, cmd);
    const event = { command, status: r.status, ok: r.ok, text: r.text };
    if (!promptChecked && (cmd.kind === 'reason' || cmd.kind === 'present')) {
      const publicInferenceId = publicId(c, 'inferences', cmd.id);
      const prompt = await playerPrompt(input, publicInferenceId);
      assert.ok(prompt.includes(`公开问题编号 ${publicInferenceId}`));
      assert.equal(prompt.includes(`公开问题编号 ${cmd.id}`), false);
      promptChecked = true;
    }
    if (cmd.kind === 'reason' || cmd.kind === 'present') decisions.push({ input, output: { command }, result: event });
    transcript.push(event); state = r.state;
  }
  const record = { ok: true, transcript, decisions, finalState: state };
  assert.equal(blindTranscriptValid(c, record), true);
  assert.equal(blindTranscriptValid(c, { ...record, decisions: [] }), false);
  assert.equal(blindTranscriptValid(c, { ...record, decisions: decisions.slice(1) }), false);
  const future = structuredClone(record); future.decisions[0]!.input.transcript = transcript;
  assert.equal(blindTranscriptValid(c, future), false);
  const altered = structuredClone(record); altered.decisions[0]!.input.view = playerView(c, state);
  assert.equal(blindTranscriptValid(c, altered), false);
});

test('the complete blind driver works when author inference IDs differ from public handles', async () => {
  const c = fixtureV2();
  c.resolution.identityInferenceId = 'author_' + c.resolution.identityInferenceId;
  for (const i of c.inferences) i.id = 'author_' + i.id;
  assert.equal(audit(c).ok, true);
  const dir = await mkdtemp(join(tmpdir(), 'detective-blind-driver-test-'));
  try {
    const result = await blindPlay(c, dir, { provider: 'codex', model: 'software-fixture', timeoutMs: 1000 }, 12, async prompt => {
      const target = /公开问题编号 (d[1-9][0-9]*)/.exec(prompt)![1]!;
      const packet = JSON.parse(prompt.slice(prompt.lastIndexOf('玩家输入：') + '玩家输入：'.length)) as ReturnType<typeof playerPacket>;
      assert.ok(packet.view.inferences.some(x => x.id === target));
      assert.equal(prompt.includes('author_d'), false);
      // A software fixture supplies a valid decision; this is not model-generation evidence.
      const i = c.inferences[Number(target.slice(1)) - 1]!, solution = i.solutions[0]!;
      return JSON.stringify({ command: { kind: i.claimId ? 'present' : 'reason', id: target,
        claimId: i.claimId ? publicId(c, 'claims', i.claimId) : null,
        optionId: orderedOptions(c, i).find(x => x.internalId === solution.optionId)!.choice,
        evidenceIds: solution.evidenceIds.map(x => publicId(c, 'evidence', x)) }, reasoning: 'software fixture' });
    });
    assert.equal(result.ok, true); assert.equal(result.decisions.length, c.inferences.length);
    assert.equal(blindTranscriptValid(c, result), true);
  } finally { await removeTempDirectory(dir, tmpdir(), 'detective-blind-driver-test-'); }
});
