import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureV2 } from './v2fixture.js';
import { initialState, playerView, stateKey, transition } from '../src/engine.js';
import { audit, validate } from '../src/validate.js';
import { publicId, resolvePlayerCommand } from '../src/public.js';
import { isV2State } from '../src/state-rules.js';

test('v2 requires meaningful press, statement-targeted evidence, revision, mechanism and identity before ending', () => {
  const c = fixtureV2(), report = audit(c);
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  const trace = report.search!.replay!;
  assert.ok(trace.steps.some(x => x.command.kind === 'press'));
  assert.ok(trace.steps.filter(x => x.command.kind === 'present').length >= 2);
  assert.deepEqual(trace.finalState.solved, ['contradiction', 'mechanism', 'identity']);
  assert.equal(trace.ended, true);
  const revised = trace.steps.find(x => x.after.claims.includes('revision'))!;
  assert.ok(isV2State(revised.after) && revised.after.refuted.includes('claim'));
  assert.equal(revised.before.claims.includes('revision'), false);
  assert.equal(revised.after.moods!.clerk, 'shaken');
});

test('premature identity ending, missing dependency, and early revised testimony are rejected', () => {
  const a = fixtureV2(); a.ending.requires.knowledge = ['k_conclusion'];
  assert.ok(validate(a).issues.some(x => x.code === 'identity-ending'));
  const b = fixtureV2(); b.inferences[2]!.solutions[0]!.knowledgeIds = ['k_trace'];
  assert.ok(validate(b).issues.some(x => x.code === 'identity-dependency'));
  const d = fixtureV2(); d.actions[0]!.effects.push({ kind: 'claim', id: 'revision' });
  assert.ok(validate(d).issues.some(x => x.code === 'revision-bypass'));
});

test('balanced option lengths are enforced without using the answer mapping', () => {
  const c = fixtureV2(); c.inferences[0]!.options[0]!.text = '很长的论证'.repeat(30);
  assert.ok(validate(c).issues.some(x => x.code === 'option-length-leak'));
});

test('press repetition, wrong target, stale testimony and snapshot changes remain deterministic', () => {
  const c = fixtureV2();
  let s = transition(c, initialState(c), { kind: 'act', id: 'talk' }).state;
  const p = transition(c, s, { kind: 'press', id: 'claim' });
  assert.equal(p.ok, true); assert.ok(isV2State(s)); assert.deepEqual(s.pressed, []);
  assert.equal(stateKey(transition(c, p.state, { kind: 'press', id: 'claim' }).state), stateKey(p.state));
  const clone = structuredClone(p.state); assert.ok(isV2State(clone)); clone.moods.clerk = 'angry';
  assert.notEqual(stateKey(clone), stateKey(p.state));
  assert.equal(transition(c, p.state, { kind: 'present', id: 'contradiction', claimId: 'revision', optionId: 'alpha', evidenceIds: [] }).ok, false);
  const report = audit(c), revised = report.search!.replay!.steps.find(x => isV2State(x.after) && x.after.refuted.includes('claim'))!.after;
  assert.equal(transition(c, revised, { kind: 'press', id: 'claim' }).ok, false);
  const view = playerView(c, revised); assert.equal(view.claims.find(x => x.id === publicId(c, 'claims', 'claim'))!.active, false);
});

test('only neutral public handles and option numbers resolve at the player command boundary', () => {
  const c = fixtureV2(), s = initialState(c);
  assert.equal(resolvePlayerCommand(c, s, { kind: 'act', id: 'talk' }), null);
  assert.deepEqual(resolvePlayerCommand(c, s, { kind: 'act', id: 'a1' }), { kind: 'act', id: 'talk' });
  assert.equal(resolvePlayerCommand(c, s, { kind: 'reason', id: 'd1', optionId: 'alpha', evidenceIds: [] }), null);
});
