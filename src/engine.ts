import type { Case, Command, Condition, Result, State } from './model.js';

const add = (a: string[], x: string) => { if (!a.includes(x)) a.push(x); };
export const satisfies = (state: State, c: Condition): boolean =>
  (['knowledge', 'evidence', 'claims', 'flags'] as const).every(k => c[k].every(x => state[k].includes(x)));
export function initialState(c: Case): State {
  return { locationId: c.initial.locationId, knowledge: [...c.initial.knowledge], flags: [...c.initial.flags],
    evidence: [], claims: [], completed: [], solved: [], ended: false };
}
export function opening(c: Case): string[] {
  return [c.prologue, ...c.initial.knowledge.map(x => c.knowledge.find(k => k.id === x)!.text),
    c.locations.find(x => x.id === c.initial.locationId)!.description];
}
function grantKnowledge(c: Case, s: State, id: string, output: string[]) {
  if (!s.knowledge.includes(id)) { add(s.knowledge, id); output.push(c.knowledge.find(k => k.id === id)!.text); }
}
function finish(c: Case, s: State, output: string[]) {
  if (!s.ended && satisfies(s, c.ending.requires)) { s.ended = true; output.push(c.ending.text); }
}
export function transition(c: Case, state: State, command: Command): Result {
  const s = structuredClone(state), output: string[] = [];
  const reject = (status: string, text: string): Result => ({ ok: false, status, state: s, text: [text] });
  if (s.ended) return reject('ended', '案件已结案。');
  if (command.kind === 'move') {
    const loc = c.locations.find(x => x.id === command.id);
    if (!loc) return reject('unknown-location', '这个地点不存在。');
    s.locationId = loc.id; output.push(loc.description);
  } else if (command.kind === 'act') {
    const a = c.actions.find(x => x.id === command.id);
    if (!a) return reject('unknown-action', '这个调查行动不存在。');
    if (a.locationId !== s.locationId || !satisfies(s, a.requires))
      return reject('unavailable', '现在还不能进行这项调查，请核对地点及已获信息。');
    if (s.completed.includes(a.id)) return { ok: true, status: 'repeat', state: s, text: [a.repeatText] };
    output.push(a.text); add(s.completed, a.id);
    for (const e of a.effects) {
      if (e.kind === 'knowledge') grantKnowledge(c, s, e.id, output);
      if (e.kind === 'flag') add(s.flags, e.id);
      if (e.kind === 'claim' && !s.claims.includes(e.id)) {
        add(s.claims, e.id);
        const claim = c.claims.find(x => x.id === e.id)!;
        output.push(`${c.characters.find(x => x.id === claim.characterId)!.name}：${claim.text}`);
      }
      if (e.kind === 'evidence' && !s.evidence.includes(e.id)) {
        add(s.evidence, e.id);
        const item = c.evidence.find(x => x.id === e.id)!;
        output.push(`取得证物「${item.name}」：${item.description}`, `来源：${item.source}；可靠性：${item.reliability}；限制：${item.limitations}`);
        item.knowledgeIds.forEach(k => grantKnowledge(c, s, k, output));
      }
    }
  } else {
    const i = c.inferences.find(x => x.id === command.id);
    if (!i) return reject('unknown-inference', '这个推理问题不存在。');
    if (i.locationId !== s.locationId || !satisfies(s, i.requires) || (i.claimId && !s.claims.includes(i.claimId)))
      return reject('unavailable', '先获取相关陈述并完成前置调查。');
    if (s.solved.includes(i.id)) return { ok: true, status: 'repeat', state: s, text: ['这项推理已经确认。'] };
    if (!i.options.some(o => o.id === command.optionId)) return reject('unknown-option', '没有这个论证选项。');
    if (command.evidenceIds.some(id => !s.evidence.includes(id))) return reject('unowned-evidence', '只能出示已经取得的证物。');
    const solution = i.solutions.find(x => x.optionId === command.optionId &&
      x.evidenceIds.every(e => command.evidenceIds.includes(e)) && x.knowledgeIds.every(k => s.knowledge.includes(k)));
    if (!solution) return reject('wrong-reasoning', i.failureText);
    output.push(i.successText); add(s.solved, i.id);
    grantKnowledge(c, s, i.conclusionKnowledgeId, output);
    i.unlockFlags.forEach(x => add(s.flags, x));
  }
  finish(c, s, output);
  return { ok: true, status: s.ended ? 'ending' : 'advanced', state: s, text: output };
}

// This whitelist is the only payload a player/renderer receives. No answer map or truth.
export function playerView(c: Case, s: State) {
  return {
    title: c.title, ended: s.ended,
    location: c.locations.find(x => x.id === s.locationId),
    locations: c.locations.map(x => ({ id: x.id, name: x.name })),
    characters: c.characters.map(x => ({ id: x.id, name: x.name, role: x.role, description: x.publicDescription })),
    knowledge: c.knowledge.filter(x => s.knowledge.includes(x.id)).map(x => ({ id: x.id, text: x.text })),
    evidence: c.evidence.filter(x => s.evidence.includes(x.id)).map(({ id, name, description, source, reliability, limitations }) => ({ id, name, description, source, reliability, limitations })),
    claims: c.claims.filter(x => s.claims.includes(x.id)).map(({ id, characterId, text }) => ({ id, characterId, text })),
    actions: c.actions.filter(a => a.locationId === s.locationId && satisfies(s, a.requires))
      .map(a => ({ id: a.id, kind: a.kind, label: a.label, completed: s.completed.includes(a.id) })),
    inferences: c.inferences.filter(i => i.locationId === s.locationId && satisfies(s, i.requires) && (!i.claimId || s.claims.includes(i.claimId)))
      .map(i => ({ id: i.id, label: i.label, question: i.question, options: i.options, solved: s.solved.includes(i.id) })),
  };
}
export const stateKey = (s: State): string => JSON.stringify({ ...s,
  knowledge: [...s.knowledge].sort(), evidence: [...s.evidence].sort(), claims: [...s.claims].sort(),
  flags: [...s.flags].sort(), completed: [...s.completed].sort(), solved: [...s.solved].sort(),
});
