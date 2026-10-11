import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.js';
import { initialState, playerView, transition } from '../src/engine.js';

test('player projection removes correctness-bearing author IDs even in legacy cases', () => {
  const c = fixture();
  c.inferences[0]!.options[0]!.id = 'secret_right';
  c.inferences[0]!.solutions[0]!.optionId = 'secret_right';
  const s = transition(c, initialState(c), { kind: 'act', id: 'talk' }).state;
  const view = playerView(c, s);
  assert.equal(JSON.stringify(view).includes('secret_right'), false);
  assert.equal(JSON.stringify(view).includes('contradiction'), false);
  assert.ok(view.inferences[0]!.options.every(o => Object.keys(o).sort().join() === 'choice,text'));
});

test('public option ordering and handles do not depend on the author answer mapping', () => {
  const c = fixture(), s = transition(c, initialState(c), { kind: 'act', id: 'talk' }).state;
  const alternate = structuredClone(c);
  alternate.inferences[0]!.solutions[0]!.optionId = 'age';
  assert.deepEqual(playerView(c, s), playerView(alternate, s));
});
