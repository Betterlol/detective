import { designSchema } from '../src/design.js';
import type { CaseV2 } from '../src/model.js';
import { fixtureV2 } from './v2fixture.js';

export function fixtureDesign(c: CaseV2 = fixtureV2()) {
  const actor = c.characters.find(x => x.id === c.truth.culpritId)!;
  return designSchema.parse({
    title: c.title, theme: c.theme, coreAct: c.truth.facts.find(x => x.id === c.resolution.actFactId)!.text,
    actor: { id: actor.id, name: actor.name, motive: actor.privateMotive },
    suspects: c.characters.map(x => ({ id: x.id, name: x.name, role: x.role, apparentSuspicion: '待查疑点', exclusionMaterial: '独立影像核对' })),
    truthFacts: c.truth.facts,
    timeline: Array.from({ length: 3 }, (_, n) => ({ time: `${n}:00`, actorId: actor.id, location: '档案室', text: '时间线测试记录' })),
    mechanism: { description: '底部检修口调换', physicalConstraints: ['正门封闭'], materialEvidence: ['柜底结构', '连续影像'] },
    identityArgument: { independentObservations: ['身份与动作连续', '另一候选人在外核验'], causalAttribution: '管理员实施操作',
      excludedAlternatives: c.characters.filter(x => x.id !== actor.id).map(x => ({ suspectId: x.id, hypothesis: '代做', rebuttal: '持续在外', source: '独立影像' })) },
    testimonyEvolution: [{ characterId: actor.id, originalClaim: '9点开过正门', pressedDetail: '时间与地点', contradictionEvidence: ['封条'], revision: '底部可能被动过', nextInvestigation: '检查柜底' }],
    revealPlan: ['矛盾', '机制', '身份'].map(question => ({ question, availableEvidence: ['可调查材料'], warrantedConclusion: question, nextStep: '进一步核查' })),
    closure: '管理员实施调换', risks: ['仅为软件测试 fixture，不作为模型生成证据'],
  });
}
