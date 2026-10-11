import { designSchema, type Design } from './design.js';
import type { CaseV2 } from './model.js';
import type { Issue } from './validation-types.js';

export function auditDesign(input: unknown): { ok: boolean; issues: Issue[]; design?: Design } {
  const parsed = designSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(x => ({ code: 'design-schema', path: x.path.join('.'), message: x.message })) };
  const d = parsed.data, issues: Issue[] = [];
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message });
  for (const [path, entries] of [['suspects', d.suspects], ['truthFacts', d.truthFacts]] as const) {
    if (new Set(entries.map(x => x.id)).size !== entries.length) issue('design-duplicate', path, 'ID 必须唯一');
  }
  const suspects = new Set(d.suspects.map(x => x.id));
  if (!suspects.has(d.actor.id) || d.suspects.find(x => x.id === d.actor.id)?.name !== d.actor.name)
    issue('design-actor', 'actor', '实施者必须属于候选人且姓名一致');
  d.timeline.forEach((x, n) => { if (!suspects.has(x.actorId)) issue('design-reference', `timeline.${n}.actorId`, '时间线人物不存在'); });
  d.testimonyEvolution.forEach((x, n) => { if (!suspects.has(x.characterId)) issue('design-reference', `testimonyEvolution.${n}.characterId`, '证人不存在'); });
  const excluded = d.identityArgument.excludedAlternatives.map(x => x.suspectId);
  const expected = d.suspects.filter(x => x.id !== d.actor.id).map(x => x.id);
  if (excluded.length !== expected.length || new Set(excluded).size !== excluded.length || expected.some(x => !excluded.includes(x)))
    issue('design-exclusions', 'identityArgument.excludedAlternatives', '必须恰好覆盖所有其他候选人，不得排除实施者本人');
  return { ok: issues.length === 0, issues, design: d };
}

export function designConsistency(d: Design, c: CaseV2): Issue[] {
  const issues: Issue[] = [];
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message });
  if (c.truth.culpritId !== d.actor.id) issue('design-actor', 'truth.culpritId', '实施者与已验收设计不一致');
  for (const person of d.suspects) {
    if (c.characters.find(x => x.id === person.id)?.name !== person.name)
      issue('design-character', `characters.${person.id}`, '设计人物的 ID 与姓名必须保留');
  }
  const expected = d.suspects.map(x => x.id);
  if (c.resolution.suspectIds.length !== expected.length || expected.some(x => !c.resolution.suspectIds.includes(x)))
    issue('design-suspects', 'resolution.suspectIds', '候选人集合与已验收设计不一致');
  for (const fact of d.truthFacts) if (c.truth.facts.find(x => x.id === fact.id)?.text !== fact.text)
    issue('design-fact', `truth.facts.${fact.id}`, '已验收的基石事实必须保留 ID 和原文；需修改时先修订设计');
  return issues;
}
