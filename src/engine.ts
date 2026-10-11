import type { Case, Command, Condition, Result, State } from './model.js';
import { orderedOptions, publicId } from './public.js';

const add = (a: string[], x: string) => { if (!a.includes(x)) a.push(x); };
export const satisfies = (state: State, c: Condition): boolean =>
  (['knowledge', 'evidence', 'claims', 'flags'] as const).every(k => c[k].every(x => state[k].includes(x)));
export function initialState(c: Case): State {
  return { locationId: c.initial.locationId, knowledge: [...c.initial.knowledge], flags: [...c.initial.flags],
    evidence: [], claims: [], completed: [], solved: [], ended: false,
    ...(c.version === '2.0' ? { pressed: [], refuted: [], moods: Object.fromEntries(c.characters.map(x => [x.id, 'calm' as const])) } : {}),
  };
}
export function opening(c: Case): string[] {
  return [c.prologue, ...c.initial.knowledge.map(x => c.knowledge.find(k => k.id === x)!.text),
    c.locations.find(x => x.id === c.initial.locationId)!.description];
}
function grantKnowledge(c: Case, s: State, id: string, output: string[]) {
  if (!s.knowledge.includes(id)) { add(s.knowledge, id); output.push(c.knowledge.find(k => k.id === id)!.text); }
}
export function activeClaim(c: Case, s: State, id: string): boolean {
  return s.claims.includes(id) && !(s.refuted || []).includes(id) &&
    !(c.version === '2.0' && c.claims.some(x => s.claims.includes(x.id) && x.replacesClaimId === id));
}
function applyEffects(c: Case, s: State, effects: Case['actions'][number]['effects'], output: string[]) {
  for (const e of effects) {
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
}
function applyMoods(c: Case, s: State, changes: { characterId: string; mood: 'calm' | 'nervous' | 'angry' | 'shaken' | 'resolved' }[], output: string[]) {
  for (const x of changes) {
    s.moods![x.characterId] = x.mood;
    const label = { calm: '平静', nervous: '紧张', angry: '愤怒', shaken: '动摇', resolved: '释然' }[x.mood];
    output.push(`${c.characters.find(y => y.id === x.characterId)!.name}显得${label}。`);
  }
}
function finish(c: Case, s: State, output: string[]) {
  const identitySolved = c.version !== '2.0' || s.solved.includes(c.resolution.identityInferenceId);
  if (!s.ended && identitySolved && satisfies(s, c.ending.requires)) { s.ended = true; output.push(c.ending.text); }
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
    applyEffects(c, s, a.effects, output);
    if (c.version === '2.0') applyMoods(c, s, c.actions.find(x => x.id === a.id)!.moodChanges, output);
  } else if (command.kind === 'press') {
    if (c.version !== '2.0') return reject('unsupported', '此版本没有独立追问。');
    const claim = c.claims.find(x => x.id === command.id);
    if (!claim?.press || claim.locationId !== s.locationId || !activeClaim(c, s, claim.id)) return reject('unavailable', '这条陈述尚未取得、已被反驳，或证人此刻不在这个地点接受追问。');
    if ((s.pressed || []).includes(claim.id)) return { ok: true, status: 'repeat', state: s, text: [claim.press.repeatText] };
    if (!satisfies(s, claim.press.requires)) return reject('unavailable', '先完成追问所需的调查。');
    output.push(claim.press.text); add(s.pressed!, claim.id);
    applyEffects(c, s, claim.press.effects, output); applyMoods(c, s, claim.press.moodChanges, output);
  } else {
    const i = c.inferences.find(x => x.id === command.id);
    if (!i) return reject('unknown-inference', '这个推理问题不存在。');
    if (c.version === '2.0' && s.solved.includes(i.id)) return { ok: true, status: 'repeat', state: s, text: ['这项推理已经确认。'] };
    if (i.locationId !== s.locationId || !satisfies(s, i.requires) || (i.claimId && !activeClaim(c, s, i.claimId)))
      return reject('unavailable', '先获取相关陈述并完成前置调查。');
    if (s.solved.includes(i.id)) return { ok: true, status: 'repeat', state: s, text: ['这项推理已经确认。'] };
    if (command.kind === 'present' && (i.claimId !== command.claimId || !activeClaim(c, s, command.claimId)))
      return reject('wrong-target', '这项论证针对的是另一条陈述。');
    if (c.version === '2.0' && i.claimId && command.kind !== 'present')
      return reject('target-required', '请向这条具体证词出示证据并提出论证。');
    if (!i.options.some(o => o.id === command.optionId)) return reject('unknown-option', '没有这个论证选项。');
    if (command.evidenceIds.some(id => !s.evidence.includes(id))) return reject('unowned-evidence', '只能出示已经取得的证物。');
    const solution = i.solutions.find(x => x.optionId === command.optionId &&
      x.evidenceIds.every(e => command.evidenceIds.includes(e)) && x.knowledgeIds.every(k => s.knowledge.includes(k)));
    if (!solution) return reject('wrong-reasoning', i.failureText);
    output.push(i.successText); add(s.solved, i.id);
    grantKnowledge(c, s, i.conclusionKnowledgeId, output);
    i.unlockFlags.forEach(x => add(s.flags, x));
    if (c.version === '2.0') {
      const v2 = c.inferences.find(x => x.id === i.id)!;
      if (v2.kind === 'contradiction' && v2.claimId) add(s.refuted!, v2.claimId);
      applyEffects(c, s, v2.effects, output); applyMoods(c, s, v2.moodChanges, output);
    }
  }
  finish(c, s, output);
  return { ok: true, status: s.ended ? 'ending' : 'advanced', state: s, text: output };
}

// This whitelist is the only payload a player/renderer receives. No answer map or truth.
export function playerView(c: Case, s: State) {
  const handle = (kind: Parameters<typeof publicId>[1], id: string) => publicId(c, kind, id);
  return {
    title: c.title, ended: s.ended,
    location: { ...c.locations.find(x => x.id === s.locationId)!, id: handle('locations', s.locationId) },
    locations: c.locations.map(x => ({ id: handle('locations', x.id), name: x.name })),
    characters: c.characters.map(x => ({ id: handle('characters', x.id), name: x.name, role: x.role, description: x.publicDescription, mood: s.moods?.[x.id] || 'calm' })),
    knowledge: c.knowledge.filter(x => s.knowledge.includes(x.id)).map(x => ({ id: handle('knowledge', x.id), text: x.text })),
    evidence: c.evidence.filter(x => s.evidence.includes(x.id)).map(({ id, name, description, source, reliability, limitations }) => ({ id: handle('evidence', id), name, description, source, reliability, limitations })),
    claims: c.claims.filter(x => s.claims.includes(x.id)).map(({ id, characterId, text }) => ({ id: handle('claims', id), characterId: handle('characters', characterId), text, active: activeClaim(c, s, id), refuted: (s.refuted || []).includes(id) })),
    presses: c.version === '2.0' ? c.claims.filter(x => x.press && x.locationId === s.locationId && activeClaim(c, s, x.id) && satisfies(s, x.press.requires))
      .map(x => ({ id: handle('claims', x.id), text: x.text, completed: (s.pressed || []).includes(x.id) })) : [],
    actions: c.actions.filter(a => a.locationId === s.locationId && satisfies(s, a.requires))
      .map(a => ({ id: handle('actions', a.id), kind: a.kind, label: a.label, completed: s.completed.includes(a.id) })),
    inferences: c.inferences.filter(i => i.locationId === s.locationId && satisfies(s, i.requires) && (!i.claimId || activeClaim(c, s, i.claimId)))
      .map(i => ({ id: handle('inferences', i.id), label: i.label, question: i.question,
        claimId: i.claimId ? handle('claims', i.claimId) : null,
        options: orderedOptions(c, i).map(({ choice, text }) => ({ choice, text })), solved: s.solved.includes(i.id) })),
  };
}
export const stateKey = (s: State): string => JSON.stringify({ ...s,
  knowledge: [...s.knowledge].sort(), evidence: [...s.evidence].sort(), claims: [...s.claims].sort(),
  flags: [...s.flags].sort(), completed: [...s.completed].sort(), solved: [...s.solved].sort(),
  ...(s.pressed ? { pressed: [...s.pressed].sort(), refuted: [...(s.refuted || [])].sort(), moods: Object.fromEntries(Object.entries(s.moods || {}).sort(([a], [b]) => a.localeCompare(b))) } : {}),
});
