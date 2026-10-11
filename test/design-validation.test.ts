import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditDesign, designConsistency } from '../src/design-validation.js';
import { fixtureV2 } from './v2fixture.js';
import { fixtureDesign } from './designfixture.js';

test('foundation rejects missing characters, duplicate IDs and incomplete actor exclusions', () => {
  assert.equal(auditDesign(fixtureDesign()).ok, true);
  for (const mutate of [
    (d: ReturnType<typeof fixtureDesign>) => { d.timeline[0]!.actorId = 'missing'; },
    (d: ReturnType<typeof fixtureDesign>) => { d.suspects[1]!.id = d.suspects[0]!.id; },
    (d: ReturnType<typeof fixtureDesign>) => { d.truthFacts[1]!.id = d.truthFacts[0]!.id; },
    (d: ReturnType<typeof fixtureDesign>) => { d.identityArgument.excludedAlternatives = []; },
    (d: ReturnType<typeof fixtureDesign>) => { d.identityArgument.excludedAlternatives[0]!.suspectId = d.actor.id; },
    (d: ReturnType<typeof fixtureDesign>) => { d.testimonyEvolution[0]!.characterId = 'missing'; },
  ]) { const d = fixtureDesign(); mutate(d); assert.equal(auditDesign(d).ok, false); }
});

test('compiled cases must preserve accepted characters, suspects, actor and foundation facts', () => {
  const c = fixtureV2(), d = fixtureDesign(c);
  assert.deepEqual(designConsistency(d, c), []);
  const wrongActor = structuredClone(c); wrongActor.truth.culpritId = 'tech';
  assert.ok(designConsistency(d, wrongActor).some(i => i.code === 'design-actor'));
  const changed = structuredClone(c); changed.truth.facts[0]!.text = '悄悄改写原始事实';
  assert.ok(designConsistency(d, changed).some(i => i.code === 'design-fact'));
  const removed = structuredClone(c); removed.truth.facts.pop();
  assert.ok(designConsistency(d, removed).some(i => i.code === 'design-fact'));
  const renamed = structuredClone(c); renamed.characters[0]!.name = '不同人物';
  assert.ok(designConsistency(d, renamed).some(i => i.code === 'design-character'));
  const omitted = structuredClone(c); omitted.resolution.suspectIds = ['clerk'];
  assert.ok(designConsistency(d, omitted).some(i => i.code === 'design-suspects'));
});

test('retaining foundation facts cannot substitute an unrelated act as the resolution', () => {
  const c = fixtureV2(), d = fixtureDesign(c);
  d.coreAct = c.truth.facts.find(x => x.id === c.resolution.actFactId)!.text;
  c.truth.facts.push({ id: 'other_act', text: '管理员实施了另一项无关行为。' });
  c.resolution.actFactId = 'other_act';
  assert.ok(designConsistency(d, c).some(x => x.code === 'design-core-act'));
});
