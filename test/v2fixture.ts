import { caseV2Schema, emptyCondition } from '../src/model.js';
import { fixture } from './fixture.js';

// State-machine fixture only; NOT a model-generated acceptance case.
export function fixtureV2() {
  const c = fixture();
  return caseV2Schema.parse({
    ...c, version: '2.0', title: '身份链测试',
    truth: { ...c.truth, facts: [...c.truth.facts, { id: 'f_act', text: '管理员调换了柜中档案。' }] },
    knowledge: [...c.knowledge,
      { id: 'k_pressed', text: '管理员把开柜时间限定为9:00，地点限定为本柜。', factIds: [] },
      { id: 'k_tool', text: '封闭后只能从底部检修口调换档案。', factIds: ['f_act'] },
      { id: 'k_mechanism', text: '调换途径是底部检修口。', factIds: ['f_act'] },
      { id: 'k_trace', text: '连续留影拍到管理员拉开检修口并换入蓝夹；技师全程在外核验。', factIds: ['f_act'] },
      { id: 'k_identity', text: '管理员通过检修口实施档案调换。', factIds: ['f_act'] },
    ],
    evidence: [...c.evidence,
      { id: 'tool', name: '柜底结构', description: '底部检修口', source: '现场核验', reliability: '可以重复检查', limitations: '结构不能识别操作者', knowledgeIds: ['k_tool'] },
      { id: 'trace', name: '连续留影', description: '管理员操作检修口的连续影像', source: '独立归档设备', reliability: '连续、核时、当事人面部及具体操作可见', limitations: '限于该时段', knowledgeIds: ['k_trace'] },
    ],
    claims: [
      { ...c.claims[0]!, locationId: 'office', replacesClaimId: null, press: { requires: emptyCondition(), text: '管理员明确了时间与柜体。', repeatText: '时间说法没有变化。', effects: [{ kind: 'knowledge', id: 'k_pressed' }], moodChanges: [{ characterId: 'clerk', mood: 'nervous' }] } },
      { id: 'revision', characterId: 'clerk', locationId: 'archive', text: '正门没开，但档案可能从别处被动过。', truthStatus: 'truthful', privateExplanation: '改口', factIds: ['f_act'], replacesClaimId: 'claim', press: null },
    ],
    flags: [...c.flags, 'mechanism_ready'],
    actions: [...c.actions.map(a => ({ ...a, moodChanges: [] })),
      { id: 'inspect_tool', kind: 'inspect', label: '核验柜底', locationId: 'archive', targetKind: 'location', targetId: 'archive', requires: { ...emptyCondition(), knowledge: ['k_conclusion'] }, effects: [{ kind: 'evidence', id: 'tool' }], text: '核验底部结构。', repeatText: '结构未变。', moodChanges: [] },
      { id: 'inspect_trace', kind: 'inspect', label: '调取独立影像', locationId: 'archive', targetKind: 'location', targetId: 'archive', requires: { ...emptyCondition(), knowledge: ['k_mechanism'] }, effects: [{ kind: 'evidence', id: 'trace' }], text: '核对连续影像。', repeatText: '影像未变。', moodChanges: [] },
    ],
    inferences: [
      { ...c.inferences[0]!, kind: 'contradiction',
        options: [{ id: 'alpha', text: '封条10点仍完整且无法复用，9点正门开柜的说法与物证不符。' }, { id: 'beta', text: '管理员记错了一小时时间，但目前仍可认定9点正门确实开过。' }],
        solutions: [{ optionId: 'alpha', evidenceIds: ['seal', 'rule'], knowledgeIds: ['k_seal', 'k_rule', 'k_pressed'] }],
        effects: [{ kind: 'claim', id: 'revision' }], moodChanges: [{ characterId: 'clerk', mood: 'shaken' }], attribution: null,
        argument: { ...c.inferences[0]!.argument, alternatives: [{ explanation: '封条不可复用', knowledgeIds: ['k_rule'] }] },
      },
      { id: 'mechanism', kind: 'mechanism', label: '调换途径', locationId: 'archive', claimId: 'revision', requires: { ...emptyCondition(), knowledge: ['k_conclusion', 'k_tool'] }, question: '如何解释未开正门却发生调换？',
        options: [{ id: 'gamma', text: '柜体封闭状态与底部结构共同指向检修口，尚需核查具体操作人。' }, { id: 'delta', text: '柜体正门的封条完整足以否定所有调换可能，底部结构并不相关。' }],
        solutions: [{ optionId: 'gamma', evidenceIds: ['tool'], knowledgeIds: ['k_conclusion', 'k_tool'] }],
        conclusionKnowledgeId: 'k_mechanism', unlockFlags: ['mechanism_ready'], successText: '开始核对该处操作。', failureText: '解释需要与全部结构相容。', effects: [], moodChanges: [], attribution: null,
        argument: { claim: '检修口途径', relation: '结构与封闭状态', premises: [{ knowledgeId: 'k_tool', quote: '只能从底部检修口调换档案' }], alternatives: [{ explanation: '正门说法不符', knowledgeIds: ['k_conclusion'] }], consequence: '调取连续影像' },
      },
      { id: 'identity', kind: 'identity', label: '实施者', locationId: 'archive', claimId: null, requires: { ...emptyCondition(), knowledge: ['k_mechanism', 'k_trace'] }, question: '谁实施了此次调换？',
        options: [{ id: 'epsilon', text: '连续留影同时呈现管理员的身份与换入动作，技师不在柜内操作。' }, { id: 'zeta', text: '技师在场且熟悉柜体结构，因此应将换入动作归属于现场的技师。' }],
        solutions: [{ optionId: 'epsilon', evidenceIds: ['trace', 'tool'], knowledgeIds: ['k_conclusion', 'k_mechanism', 'k_trace'] }],
        conclusionKnowledgeId: 'k_identity', unlockFlags: [], successText: '具体操作得到核对。', failureText: '机会与熟悉结构不足以确定行为。', effects: [], moodChanges: [{ characterId: 'clerk', mood: 'resolved' }],
        attribution: { actorId: 'clerk', actFactIds: ['f_act'], excludedActors: [{ characterId: 'tech', knowledgeIds: ['k_trace'], explanation: '技师在外，连续影像呈现管理员动作' }] },
        argument: { claim: '管理员调换', relation: '独立影像核对实际动作', premises: [{ knowledgeId: 'k_trace', quote: '连续留影拍到管理员拉开检修口并换入蓝夹' }], alternatives: [{ explanation: '排除技师代做', knowledgeIds: ['k_trace'] }], consequence: '身份闭合' },
      },
    ],
    resolution: { identityInferenceId: 'identity', actFactId: 'f_act', suspectIds: ['clerk', 'tech'] },
    ending: { requires: { ...emptyCondition(), knowledge: ['k_conclusion', 'k_mechanism', 'k_identity'] }, text: '身份链测试结案。' },
  });
}
