import { caseSchema, type Case, type Command, type State } from './model.js';
import { initialState, opening, playerView, stateKey, transition } from './engine.js';
import { publicId } from './public.js';
import { validateV2 } from './validate-v2.js';
import type { Issue } from './validation-types.js';

export type { Issue } from './validation-types.js';
export function validate(input: unknown): { case?: Case; issues: Issue[] } {
  const parsed = caseSchema.safeParse(input);
  if (!parsed.success) return { issues: parsed.error.issues.map(x => ({ code: 'schema', path: x.path.join('.'), message: x.message })) };
  const c = parsed.data, issues: Issue[] = [];
  const registries = {
    character: c.characters, location: c.locations, fact: c.truth.facts, knowledge: c.knowledge,
    evidence: c.evidence, claim: c.claims, action: c.actions, inference: c.inferences,
    flag: c.flags.map(id => ({ id })),
  };
  type Registry = keyof typeof registries;
  const sets = Object.fromEntries(Object.entries(registries).map(([k, a]) => [k, new Set(a.map(x => x.id))])) as Record<Registry, Set<string>>;
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message });
  for (const [k, a] of Object.entries(registries)) {
    const seen = new Set<string>();
    for (const x of a) { if (seen.has(x.id)) issue('duplicate-id', k, x.id); seen.add(x.id); }
  }
  const ref = (k: Registry, xs: string[], path: string) => {
    for (const x of xs) if (!sets[k].has(x)) issue('reference', path, `${k}:${x} 不存在`);
    if (new Set(xs).size !== xs.length) issue('duplicate-reference', path, '重复引用');
  };
  const condition = (x: Case['initial'] | Case['ending']['requires'], path: string) => {
    ref('knowledge', x.knowledge, path + '.knowledge'); ref('flag', x.flags, path + '.flags');
    if ('evidence' in x) { ref('evidence', x.evidence, path + '.evidence'); ref('claim', x.claims, path + '.claims'); }
  };
  ref('character', [c.truth.culpritId], 'truth.culpritId');
  ref('location', [c.initial.locationId], 'initial.locationId'); condition(c.initial, 'initial');
  condition(c.ending.requires, 'ending.requires');
  c.characters.forEach(x => ref('fact', x.knowledgeFactIds, `characters.${x.id}.knowledgeFactIds`));
  c.truth.timeline.forEach((x, n) => {
    ref('location', [x.locationId], `truth.timeline.${n}`); ref('character', x.characterIds, `truth.timeline.${n}`);
    ref('fact', x.factIds, `truth.timeline.${n}`);
  });
  c.knowledge.forEach(x => ref('fact', x.factIds, `knowledge.${x.id}.factIds`));
  c.evidence.forEach(x => ref('knowledge', x.knowledgeIds, `evidence.${x.id}.knowledgeIds`));
  c.claims.forEach(x => { ref('character', [x.characterId], `claims.${x.id}.characterId`); ref('fact', x.factIds, `claims.${x.id}.factIds`); });
  const conclusions = new Set(c.inferences.map(x => x.conclusionKnowledgeId));
  if (conclusions.size !== c.inferences.length) issue('conclusion-alias', 'inferences', '不同推理不能共用结论 ID');
  for (const a of c.actions) {
    ref('location', [a.locationId], `actions.${a.id}.locationId`); ref(a.targetKind, [a.targetId], `actions.${a.id}.targetId`);
    condition(a.requires, `actions.${a.id}.requires`);
    for (const e of a.effects) {
      ref(e.kind, [e.id], `actions.${a.id}.effects`);
      if (e.kind === 'knowledge' && conclusions.has(e.id)) issue('bypass', `actions.${a.id}`, '调查不能直接授予推理结论');
    }
  }
  for (const e of c.evidence) if (e.knowledgeIds.some(x => conclusions.has(x))) issue('bypass', `evidence.${e.id}`, '证物不能直接授予推理结论');
  for (const k of c.initial.knowledge) if (conclusions.has(k)) issue('bypass', 'initial', '开场不能包含推理结论');
  for (const i of c.inferences) {
    const p = `inferences.${i.id}`;
    ref('location', [i.locationId], p); if (i.claimId) ref('claim', [i.claimId], p);
    condition(i.requires, p + '.requires'); ref('knowledge', [i.conclusionKnowledgeId], p); ref('flag', i.unlockFlags, p);
    const opts = new Set(i.options.map(x => x.id));
    if (opts.size !== i.options.length) issue('duplicate-id', p + '.options', '论证选项 ID 重复');
    for (const s of i.solutions) {
      if (!opts.has(s.optionId)) issue('reference', p + '.solutions', `option:${s.optionId} 不存在`);
      ref('evidence', s.evidenceIds, p + '.solutions'); ref('knowledge', s.knowledgeIds, p + '.solutions');
      for (const premise of i.argument.premises) if (!s.knowledgeIds.includes(premise.knowledgeId))
        issue('ungated-premise', p, `成功条件未要求前提 ${premise.knowledgeId}`);
      if (s.knowledgeIds.includes(i.conclusionKnowledgeId)) issue('circular-inference', p, '先有结论才能推理');
    }
    for (const premise of i.argument.premises) {
      ref('knowledge', [premise.knowledgeId], p + '.argument');
      const k = c.knowledge.find(x => x.id === premise.knowledgeId);
      if (k && !k.text.includes(premise.quote)) issue('invisible-premise', p, `前提引文不在玩家文本中：${premise.quote}`);
    }
    if (!c.ending.requires.knowledge.includes(i.conclusionKnowledgeId))
      issue('optional-core-inference', p, '原型要求每项关键推理结论作为结案条件');
  }
  if (c.version === '2.0') validateV2(c, issues);
  return { case: c, issues };
}

export type TraceStep = { command: Command; status: string; text: string[]; before: State; after: State; playerBefore: ReturnType<typeof playerView> };
export function replay(c: Case, commands: Command[]) {
  let state = initialState(c);
  const steps: TraceStep[] = [];
  for (const command of commands) {
    const before = state, result = transition(c, state, command);
    steps.push({ command, status: result.status, text: result.text, before, after: result.state, playerBefore: playerView(c, before) });
    if (!result.ok) throw new Error(`回放失败 ${JSON.stringify(command)}: ${result.status}`);
    state = result.state;
  }
  return { opening: opening(c), steps, ended: state.ended, finalState: state };
}

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
    for (const id of s.pressed || []) {
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

export function audit(input: unknown, limit = 100_000) {
  const v = validate(input);
  if (!v.case || v.issues.some(x => x.severity !== 'warning')) return { ok: false, issues: v.issues, search: null };
  const result = search(v.case, limit);
  return { ok: result.ok, issues: [...v.issues, ...result.issues], search: result };
}

// Evidence sheet derived from execution, not from the reviewer's recollection of the trace.
export function inferenceEvidence(c: Case, trace: ReturnType<typeof replay>) {
  const acquired = (kind: 'knowledge' | 'evidence' | 'claims', id: string): number | null => {
    if (initialState(c)[kind].includes(id)) return 0;
    const n = trace.steps.findIndex(s => !s.before[kind].includes(id) && s.after[kind].includes(id));
    return n < 0 ? null : n + 1;
  };
  return trace.steps.flatMap((step, n) => {
    if (step.command.kind !== 'reason' && step.command.kind !== 'present') return [];
    const i = c.inferences.find(x => x.id === step.command.id)!;
    const command = step.command;
    const solution = i.solutions.find(x => x.optionId === command.optionId && x.evidenceIds.every(e => command.evidenceIds.includes(e)))!;
    return [{ inferenceId: i.id, executedAt: n + 1, question: i.question,
      claim: i.claimId ? { ...step.playerBefore.claims.find(x => x.id === publicId(c, 'claims', i.claimId!)), acquiredAt: acquired('claims', i.claimId) } : null,
      submittedArgument: i.options.find(x => x.id === command.optionId)!.text,
      evidence: command.evidenceIds.map(id => ({ ...step.playerBefore.evidence.find(x => x.id === publicId(c, 'evidence', id)), acquiredAt: acquired('evidence', id) })),
      prerequisites: solution.knowledgeIds.map(id => ({ id, text: step.playerBefore.knowledge.find(x => x.id === publicId(c, 'knowledge', id))?.text,
        acquiredAt: acquired('knowledge', id), presentBeforeReasoning: step.before.knowledge.includes(id) })),
      premises: i.argument.premises.map(p => ({ ...p, acquiredAt: acquired('knowledge', p.knowledgeId),
        visibleBeforeReasoning: !!step.playerBefore.knowledge.find(k => k.id === publicId(c, 'knowledge', p.knowledgeId))?.text.includes(p.quote) })),
      progressionText: step.text, authorRelation: i.argument.relation,
      limit: '只证明这些文字在执行时已呈现与条件满足，论证蕴含关系仍须文本审查。',
    }];
  });
}
