import type { CaseV2 } from './model.js';
import type { Issue } from './validate.js';

export function validateV2(c: CaseV2, issues: Issue[]) {
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message });
  const warning = (code: string, path: string, message: string) => issues.push({ code, path, message, severity: 'warning' });
  const sets = { knowledge: new Set(c.knowledge.map(x => x.id)), evidence: new Set(c.evidence.map(x => x.id)),
    claim: new Set(c.claims.map(x => x.id)), flag: new Set(c.flags), character: new Set(c.characters.map(x => x.id)),
    location: new Set(c.locations.map(x => x.id)), fact: new Set(c.truth.facts.map(x => x.id)) };
  const ref = (kind: keyof typeof sets, ids: string[], path: string) => {
    ids.forEach(id => { if (!sets[kind].has(id)) issue('reference', path, `${kind}:${id} 不存在`); });
  };
  const conclusions = new Set(c.inferences.map(x => x.conclusionKnowledgeId));
  const checkEffects = (effects: CaseV2['actions'][number]['effects'], path: string, fromInference = false) => {
    for (const e of effects) {
      ref(e.kind, [e.id], path);
      if (e.kind === 'knowledge' && conclusions.has(e.id)) issue('bypass', path, '额外效果不得代替推理自动授予其他结论');
      const claim = e.kind === 'claim' ? c.claims.find(x => x.id === e.id) : null;
      if (claim?.replacesClaimId && !fromInference) issue('revision-bypass', path, '修订陈述必须由前一陈述的成功反驳授予');
    }
  };
  const checkMoods = (changes: { characterId: string }[], path: string) => ref('character', changes.map(x => x.characterId), path);
  for (const a of c.actions) { checkEffects(a.effects, `actions.${a.id}`); checkMoods(a.moodChanges, `actions.${a.id}.moodChanges`); }
  for (const claim of c.claims) {
    const path = `claims.${claim.id}`;
    ref('location', [claim.locationId], path);
    if (claim.replacesClaimId) {
      ref('claim', [claim.replacesClaimId], path);
      const prior = c.claims.find(x => x.id === claim.replacesClaimId);
      if (prior?.characterId !== claim.characterId) issue('revision-character', path, '修订陈述必须属于同一证人');
      const sources = c.inferences.filter(i => i.effects.some(e => e.kind === 'claim' && e.id === claim.id));
      if (!sources.length || sources.some(i => i.kind !== 'contradiction' || i.claimId !== claim.replacesClaimId))
        issue('revision-source', path, '修订来源必须是成功反驳其被替代陈述的节点');
      let cursor: typeof claim | undefined = prior;
      const seen = new Set([claim.id]);
      while (cursor) {
        if (seen.has(cursor.id)) { issue('revision-cycle', path, '证词修订形成循环'); break; }
        seen.add(cursor.id); cursor = c.claims.find(x => x.id === cursor?.replacesClaimId);
      }
    }
    if (claim.press) {
      const p = claim.press;
      ref('knowledge', p.requires.knowledge, path); ref('evidence', p.requires.evidence, path);
      ref('claim', p.requires.claims, path); ref('flag', p.requires.flags, path);
      checkEffects(p.effects, path + '.press'); checkMoods(p.moodChanges, path + '.press');
    }
  }
  const pressedPrerequisite = c.claims.some(claim => claim.press?.effects.some(e =>
    (e.kind === 'knowledge' && c.inferences.some(i => i.solutions.some(s => s.knowledgeIds.includes(e.id)))) ||
    (e.kind === 'evidence' && c.inferences.some(i => i.solutions.some(s => s.evidenceIds.includes(e.id))))));
  if (!pressedPrerequisite) issue('meaningless-press', 'claims', '至少一次追问必须提供推理需要的知识或证物');
  if (!c.claims.some(x => x.replacesClaimId)) issue('missing-revision', 'claims', '需要至少一轮成功反驳后的修订陈述');
  if (!c.inferences.some(x => x.kind === 'contradiction' && x.claimId)) issue('missing-contradiction', 'inferences', '缺少针对具体证词的矛盾质询');
  if (!c.inferences.some(x => x.kind === 'mechanism')) issue('missing-mechanism', 'inferences', '缺少行为机制推理');
  ref('fact', [c.resolution.actFactId], 'resolution.actFactId'); ref('character', c.resolution.suspectIds, 'resolution.suspectIds');
  const identity = c.inferences.find(x => x.id === c.resolution.identityInferenceId);
  if (!identity || identity.kind !== 'identity' || c.inferences.filter(x => x.kind === 'identity').length !== 1)
    issue('identity-resolution', 'resolution', '必须指定唯一的身份归属节点');
  if (identity && !c.ending.requires.knowledge.includes(identity.conclusionKnowledgeId)) issue('identity-ending', 'ending', '结案必须要求身份推理结论');
  for (const i of c.inferences) {
    const path = `inferences.${i.id}`;
    checkEffects(i.effects, path + '.effects', true); checkMoods(i.moodChanges, path + '.moodChanges');
    if (i.claimId && c.claims.find(x => x.id === i.claimId)?.locationId !== i.locationId) issue('claim-location', path, '证词和质询地点不一致');
    const lengths = i.options.map(x => Array.from(x.text.replace(/\s/g, '')).length);
    const shortest = Math.min(...lengths), longest = Math.max(...lengths);
    if (longest - shortest >= 80 && longest / Math.max(shortest, 1) >= 2)
      warning('option-length-leak', path + '.options', '选项长度差异较大；这只是弱提示，不证明存在或不存在答案线索，也不阻断验收');
    for (const alternative of i.argument.alternatives) {
      ref('knowledge', alternative.knowledgeIds, path + '.argument.alternatives');
      if (i.solutions.some(s => alternative.knowledgeIds.some(k => !s.knowledgeIds.includes(k))))
        issue('ungated-alternative', path, '替代解释的排除依据必须在所有解法中先被玩家取得');
    }
    if (i.kind === 'contradiction' && !i.claimId) issue('missing-target', path, '矛盾节点必须针对具体证词');
    if (i.kind !== 'identity' && i.attribution) issue('premature-attribution', path, '完整归属只由身份节点确立');
    if (i.kind === 'identity') {
      const a = i.attribution;
      if (!a) { issue('identity-attribution', path, '身份节点缺少实施者归属依据'); continue; }
      ref('character', [a.actorId], path); ref('fact', a.actFactIds, path);
      if (a.actorId !== c.truth.culpritId || !a.actFactIds.includes(c.resolution.actFactId) || !c.resolution.suspectIds.includes(a.actorId))
        issue('identity-truth', path, '身份结论必须匹配核心行为和作者实施者');
      const conclusion = c.knowledge.find(k => k.id === i.conclusionKnowledgeId);
      if (!conclusion?.factIds.includes(c.resolution.actFactId)) issue('identity-fact', path, '身份结论未关联核心行为事实');
      const requiredPrior = c.inferences.filter(x => x.id !== i.id).map(x => x.conclusionKnowledgeId);
      if (i.solutions.some(s => requiredPrior.some(k => !s.knowledgeIds.includes(k))))
        issue('identity-dependency', path, '每个身份解法都必须要求此前核心推理结论');
      const excluded = a.excludedActors.map(x => x.characterId);
      const expected = c.resolution.suspectIds.filter(x => x !== a.actorId);
      if (new Set(excluded).size !== excluded.length || excluded.length !== expected.length || expected.some(x => !excluded.includes(x)))
        issue('identity-alternatives', path, '必须覆盖所有其他候选实施者，不能排除自己或重复排除');
      for (const other of a.excludedActors) {
        ref('character', [other.characterId], path); ref('knowledge', other.knowledgeIds, path);
        if (i.solutions.some(s => other.knowledgeIds.some(k => !s.knowledgeIds.includes(k)))) issue('identity-premise', path, '候选排除依据未作为成功前提');
      }
    }
  }
  // Exact pre-acquisition copies of a conclusion are detectable; paraphrases require the independent text review.
  for (const i of c.inferences) {
    const conclusion = c.knowledge.find(k => k.id === i.conclusionKnowledgeId)?.text;
    if (!conclusion) continue;
    if (c.knowledge.some(k => k.id !== i.conclusionKnowledgeId && k.text.includes(conclusion)) || c.prologue.includes(conclusion))
      issue('early-conclusion', `inferences.${i.id}`, '待推理结论已完整提前出现在观察或开场中');
  }
}
