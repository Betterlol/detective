import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.js';
import { initialState, opening, playerView, stateKey, transition } from '../src/engine.js';
import { audit, replay, validate } from '../src/validate.js';
import type { Command, State } from '../src/model.js';

test('fixture passes structural checks and exhaustive reachability from every legal exploration order', () => {
  const result = audit(fixture()); assert.equal(result.ok, true);
  assert.equal(result.search?.exhaustive, true); assert.equal(result.search?.softlockedStates, 0);
  assert.equal(result.search?.replay?.ended, true); assert.ok(result.search!.probes > 50);
});
test('actual replay is deterministic and correct reasoning needs argument, evidence, and acquired premises', () => {
  const c = fixture(), solution: Command = { kind: 'reason', id: 'contradiction', optionId: 'contradicts', evidenceIds: ['seal', 'rule'] };
  let s = transition(c, initialState(c), { kind: 'act', id: 'talk' }).state;
  assert.equal(transition(c, s, solution).ok, false);
  s = transition(c, s, { kind: 'move', id: 'archive' }).state;
  s = transition(c, s, { kind: 'act', id: 'photo' }).state;
  s = transition(c, s, { kind: 'act', id: 'manual' }).state;
  s = transition(c, s, { kind: 'move', id: 'office' }).state;
  assert.equal(transition(c, s, { ...solution, optionId: 'age' }).ok, false);
  assert.equal(transition(c, s, { ...solution, evidenceIds: ['seal'] }).ok, false);
  const withoutPremise: State = { ...s, knowledge: s.knowledge.filter(x => x !== 'k_rule') };
  assert.equal(transition(c, withoutPremise, solution).ok, false);
  const result = transition(c, s, solution); assert.equal(result.state.ended, true);
  assert.ok(result.text.includes(c.ending.text)); assert.equal(s.ended, false);
  const commands = audit(c).search!.commands;
  assert.deepEqual(replay(c, commands), replay(c, commands));
  assert.equal(transition(c, result.state, { kind: 'act', id: 'side' }).status, 'ended');
});
test('wrong operations, unavailable actions and repetitions preserve state and do not mutate input', () => {
  const c = fixture(), initial = initialState(c), original = structuredClone(initial);
  for (const command of [
    { kind: 'act', id: 'photo' }, { kind: 'act', id: 'nonexistent' }, { kind: 'move', id: 'nonexistent' },
    { kind: 'reason', id: 'contradiction', optionId: 'age', evidenceIds: [] },
  ] as Command[]) assert.equal(stateKey(transition(c, initial, command).state), stateKey(initial));
  assert.deepEqual(initial, original);
  const result = transition(c, initial, { kind: 'act', id: 'talk' });
  const repeat = transition(c, result.state, { kind: 'act', id: 'talk' });
  assert.equal(repeat.status, 'repeat'); assert.deepEqual(repeat.state, result.state);
});
test('public projection hides author truth, solution map, unavailable knowledge and claim reliability labels', () => {
  const c = fixture(), s = initialState(c), view = playerView(c, s);
  const publicJson = JSON.stringify(view);
  for (const hidden of ['SECRET_', 'privateMotive', 'truthStatus', 'solutions', 'argument', 'culpritId', 'factIds', 'k_conclusion']) assert.equal(publicJson.includes(hidden), false);
  assert.deepEqual(view.evidence, []); assert.deepEqual(view.claims, []); assert.deepEqual(view.inferences, []);
  assert.equal(opening(c).join().includes('SECRET_'), false);
  const visible = playerView(c, transition(c, s, { kind: 'act', id: 'talk' }).state);
  assert.equal(visible.claims[0]!.text, c.claims[0]!.text); assert.equal('truthStatus' in visible.claims[0]!, false);
});
test('an unavailable required evidence source is caught dynamically even when structure is legal', () => {
  const c = fixture(); c.actions.find(x => x.id === 'photo')!.requires.knowledge.push('k_conclusion');
  assert.deepEqual(validate(c).issues, []);
  const result = audit(c); assert.equal(result.ok, false);
  assert.ok(result.issues.some(x => x.code === 'unreachable-evidence'));
  assert.ok(result.issues.some(x => x.code === 'softlock'));
});
test('bad references, invisible premises, illegal effects and conclusion bypass are rejected', () => {
  const a = fixture(); a.actions[0]!.targetId = 'missing'; assert.ok(validate(a).issues.some(x => x.code === 'reference'));
  const b = fixture(); b.knowledge[0]!.text = '无关描述'; assert.ok(validate(b).issues.some(x => x.code === 'invisible-premise'));
  const c = fixture(); (c.actions[0]!.effects[0] as { kind: string }).kind = 'erase'; assert.ok(validate(c).issues.some(x => x.code === 'schema'));
  const d = fixture(); d.initial.knowledge.push('k_conclusion'); assert.ok(validate(d).issues.some(x => x.code === 'bypass'));
});
test('search limit reports unknown coverage instead of false success or an asserted softlock', () => {
  const result = audit(fixture(), 2);
  assert.equal(result.ok, false); assert.equal(result.search!.exhaustive, false); assert.equal(result.search!.softlockedStates, null);
  assert.ok(result.issues.some(x => x.code === 'search-incomplete'));
});
