import type { Case, Command, State } from './model.js';
import { initialState, stateKey, transition } from './engine.js';
import { publicId } from './public.js';
import { isV2State } from './state-rules.js';
import { replay } from './trace.js';
import type { Issue } from './validation-types.js';

export function search(c: Case, limit = 100_000) {
  const states: State[] = [initialState(c)], indexes = new Map([[stateKey(states[0]!), 0]]);
  const parents: ({ index: number; command: Command } | null)[] = [null], reverse: number[][] = [[]];
  const reachedEvidence = new Set<string>(), reachedKnowledge = new Set<string>(), endings: number[] = [];
  let cursor = 0, truncated = false, edges = 0, probes = 0;
  const issues: Issue[] = [];
  const commandsTo = (index: number): Command[] => {
    const commands: Command[] = [];
    while (parents[index]) { const p = parents[index]!; commands.push(p.command); index = p.index; }
    return commands.reverse();
  };
  while (cursor < states.length && !truncated) {
    const index = cursor++, s = states[index]!;
    s.evidence.forEach(x => reachedEvidence.add(x)); s.knowledge.forEach(x => reachedKnowledge.add(x));
    if (s.ended) { endings.push(index); continue; }
    // These commands span every possible state-changing transition. Invalid submissions are identity transitions.
    const candidates: Command[] = [
      ...c.locations.map(x => ({ kind: 'move' as const, id: x.id })),
      ...c.actions.map(x => ({ kind: 'act' as const, id: x.id })),
      ...(c.version === '2.0' ? c.claims.filter(x => x.press).map(x => ({ kind: 'press' as const, id: x.id })) : []),
      ...c.inferences.flatMap(i => i.solutions.map(x => (c.version === '2.0' && i.claimId ?
        { kind: 'present' as const, id: i.id, claimId: i.claimId, optionId: x.optionId, evidenceIds: x.evidenceIds } :
        { kind: 'reason' as const, id: i.id, optionId: x.optionId, evidenceIds: x.evidenceIds }))),
    ];
    for (const command of candidates) {
      const r = transition(c, s, command), key = stateKey(r.state);
      if (!r.ok) { probes++; if (key !== stateKey(s)) issues.push({ code: 'failure-mutates', path: 'runtime', message: JSON.stringify(command) }); }
      if (!r.ok || key === stateKey(s)) continue;
      edges++;
      let target = indexes.get(key);
      if (target === undefined) {
        if (states.length >= limit) { truncated = true; break; }
        target = states.length; indexes.set(key, target); states.push(r.state); parents.push({ index, command }); reverse.push([]);
      }
      reverse[target]!.push(index);
    }
    // Probe incorrect explanations, missing/unknown evidence and repetitions against the real engine.
    const invalid: Command[] = [{ kind: 'act', id: '__invalid__' }, { kind: 'move', id: '__invalid__' }];
    for (const i of c.inferences) {
      const submission = (optionId: string, evidenceIds: string[]): Command => c.version === '2.0' && i.claimId ?
        { kind: 'present', id: i.id, claimId: i.claimId, optionId, evidenceIds } : { kind: 'reason', id: i.id, optionId, evidenceIds };
      for (const o of i.options) if (!i.solutions.some(x => x.optionId === o.id)) invalid.push(submission(o.id, [...s.evidence]));
      for (const solution of i.solutions) {
        invalid.push(submission(solution.optionId, []));
        invalid.push(submission(solution.optionId, ['__invalid__']));
      }
    }
    for (const command of invalid) {
      const r = transition(c, s, command); probes++;
      if (stateKey(s) !== stateKey(r.state)) issues.push({ code: 'invalid-mutates', path: 'runtime', message: JSON.stringify(command) });
    }
    for (const id of s.completed) {
      const r = transition(c, s, { kind: 'act', id }); probes++;
      if (stateKey(s) !== stateKey(r.state)) issues.push({ code: 'repeat-mutates', path: 'runtime', message: id });
    }
    for (const id of isV2State(s) ? s.pressed : []) {
      const r = transition(c, s, { kind: 'press', id }); probes++;
      if (stateKey(s) !== stateKey(r.state)) issues.push({ code: 'repeat-press-mutates', path: 'runtime', message: id });
    }
  }
  const winning = new Set(endings), queue = [...endings];
  for (let n = 0; n < queue.length; n++) for (const p of reverse[queue[n]!]!) if (!winning.has(p)) { winning.add(p); queue.push(p); }
  const softlocked = states.map((_, n) => n).filter(n => !winning.has(n));
  if (truncated) issues.push({ code: 'search-incomplete', path: 'search', message: `达到 ${limit} 状态上限；可达性/软锁未确认` });
  else {
    if (!endings.length) issues.push({ code: 'no-ending', path: 'ending', message: '没有可执行的通关路径' });
    for (const e of new Set(c.inferences.flatMap(i => i.solutions.flatMap(s => s.evidenceIds))))
      if (!reachedEvidence.has(e)) issues.push({ code: 'unreachable-evidence', path: `evidence.${e}`, message: '关键证物无法获得' });
    for (const k of new Set(c.inferences.flatMap(i => i.solutions.flatMap(s => s.knowledgeIds))))
      if (!reachedKnowledge.has(k)) issues.push({ code: 'unreachable-premise', path: `knowledge.${k}`, message: '关键前提无法获得' });
    if (softlocked.length) issues.push({ code: 'softlock', path: 'search', message: `${softlocked.length} 个可达状态无法到达结局` });
  }
  const commands = endings.length ? commandsTo(endings[0]!) : [];
  return {
    ok: issues.length === 0, issues, states: states.length, edges, probes, limit, exhaustive: !truncated,
    endingStates: endings.length, softlockedStates: truncated ? null : softlocked.length,
    abstraction: '完整单调集合状态（含已完成动作、推理、地点）；拒绝与重复操作为恒等转移。成功证物超集与最小证物集同效。',
    uncovered: '自然语言逻辑、真实世界证据可靠性、玩家心理；未穷举无效输入字节串和全部证物超集，恒等性由内核及探针覆盖。',
    counterexample: !truncated && softlocked.length ? commandsTo(softlocked[0]!) : null,
    commands, replay: commands.length ? replay(c, commands) : null,
  };
}
