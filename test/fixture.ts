import { caseSchema, emptyCondition } from '../src/model.js';

// Hand-authored fixture ONLY for engine tests, never an AI generation/acceptance sample.
export function fixture() {
  return caseSchema.parse({
    version: '1.0', id: 'test_fixture', title: '测试用封条', theme: 'fixture，仅用于单元测试', prologue: '查明封条记录的矛盾。',
    characters: [
      { id: 'clerk', name: '管理员', role: '证人', publicDescription: '管理档案', privateMotive: 'SECRET_MOTIVE', knowledgeFactIds: ['f_seal'] },
      { id: 'tech', name: '技师', role: '工作人员', publicDescription: '记录流程', privateMotive: '谨慎', knowledgeFactIds: ['f_rule'] },
    ],
    locations: [{ id: 'office', name: '办公室', description: '询问处' }, { id: 'archive', name: '库房', description: '存放记录' }],
    truth: { culpritId: 'clerk', summary: 'SECRET_TRUTH', facts: [
      { id: 'f_seal', text: '封条未断' }, { id: 'f_rule', text: '开柜必断封条' }, { id: 'f_lie', text: '管理员说错了时间' },
    ], timeline: [
      { time: '10:00', locationId: 'archive', characterIds: ['tech'], factIds: ['f_seal'], text: '记录' },
      { time: '11:00', locationId: 'office', characterIds: ['clerk'], factIds: ['f_lie'], text: '作证' },
    ] },
    knowledge: [
      { id: 'k_seal', text: '原封条完整，照片摄于10:00。', factIds: ['f_seal'] },
      { id: 'k_rule', text: '本柜只有一个入口，开柜必断封条，封条编号不可复用。', factIds: ['f_rule'] },
      { id: 'k_conclusion', text: '9:00开柜的说法与记录不符。', factIds: ['f_lie'] },
      { id: 'k_side', text: '今天是例行检查日。', factIds: [] },
    ],
    evidence: [
      { id: 'seal', name: '照片', description: '10:00的完整封条', source: '连续监控', reliability: '已校时', limitations: '只拍柜门', knowledgeIds: ['k_seal'] },
      { id: 'rule', name: '柜体说明', description: '唯一入口的封条规则', source: '技师现场核对', reliability: '实物核对', limitations: '仅限本柜', knowledgeIds: ['k_rule'] },
    ],
    claims: [{ id: 'claim', characterId: 'clerk', text: '我9:00打开过这个柜子。', truthStatus: 'lie', privateExplanation: 'SECRET_EXPLANATION', factIds: ['f_lie'] }],
    flags: ['revealed'], initial: { locationId: 'office', knowledge: [], flags: [] },
    actions: [
      { id: 'talk', kind: 'talk', label: '询问', locationId: 'office', targetKind: 'character', targetId: 'clerk', requires: emptyCondition(), effects: [{ kind: 'claim', id: 'claim' }], text: '管理员给出了时间。', repeatText: '记录在案。' },
      { id: 'side', kind: 'talk', label: '闲谈', locationId: 'office', targetKind: 'character', targetId: 'tech', requires: emptyCondition(), effects: [{ kind: 'knowledge', id: 'k_side' }], text: '技师闲谈。', repeatText: '还是这些。' },
      { id: 'photo', kind: 'inspect', label: '看照片', locationId: 'archive', targetKind: 'evidence', targetId: 'seal', requires: emptyCondition(), effects: [{ kind: 'evidence', id: 'seal' }], text: '读取照片。', repeatText: '照片没有变化。' },
      { id: 'manual', kind: 'inspect', label: '读说明', locationId: 'archive', targetKind: 'evidence', targetId: 'rule', requires: emptyCondition(), effects: [{ kind: 'evidence', id: 'rule' }], text: '核对柜体。', repeatText: '说明没有变化。' },
    ],
    inferences: [{
      id: 'contradiction', label: '时间矛盾', locationId: 'office', claimId: 'claim', requires: emptyCondition(), question: '如何核对开柜时间？',
      options: [{ id: 'contradicts', text: '封条10点完整且无法复用，否定9点开柜。' }, { id: 'age', text: '证人年纪大，所以说谎。' }],
      solutions: [{ optionId: 'contradicts', evidenceIds: ['seal', 'rule'], knowledgeIds: ['k_seal', 'k_rule'] }],
      conclusionKnowledgeId: 'k_conclusion', unlockFlags: ['revealed'], successText: '管理员承认时间说法有问题。', failureText: '这个论证没有得到证据支持。',
      argument: { claim: '9点开柜', relation: '与不可复用的完整封条不相容', premises: [{ knowledgeId: 'k_seal', quote: '原封条完整' }, { knowledgeId: 'k_rule', quote: '开柜必断封条' }], alternatives: ['排除其他入口和更换封条'], consequence: '核对说法' },
    }], ending: { requires: { ...emptyCondition(), knowledge: ['k_conclusion'] }, text: '测试结案。' },
  });
}
