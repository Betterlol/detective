import { caseSchema, type Case } from './model.js';
import { validateV2 } from './validate-v2.js';
import type { Issue } from './validation-types.js';

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
