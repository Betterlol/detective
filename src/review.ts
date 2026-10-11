import { z } from 'zod';
import { type Case } from './model.js';
import { callModel, type ModelConfig } from './provider.js';
import { type TraceStep } from './validate.js';
import { saveJson } from './io.js';
import { join } from 'node:path';

const str = z.string().min(1);
export const reviewSchema = z.object({
  verdict: z.enum(['pass', 'revise']),
  issues: z.array(z.object({
    severity: z.enum(['blocking', 'minor']), category: z.enum(['facts', 'fairness', 'narrative']),
    path: str, message: str, evidenceQuote: str, suggestedRepair: str,
  }).strict()),
  inferenceReviews: z.array(z.object({
    inferenceId: str, claimQuote: str, evidenceQuotes: z.array(str).min(1),
    premiseAvailability: z.array(z.object({ knowledgeId: str, acquiredAt: z.number().int().min(0), quote: str }).strict()).min(1),
    logicalAssessment: str, alternativeAssessment: str, progressionAssessment: str,
    verdict: z.enum(['pass', 'revise']),
  }).strict()).min(1),
  narrative: z.object({ motivation: str, suspense: str, reveal: str, feedback: str, limitations: str }).strict(),
  limitations: z.array(str).min(1),
}).strict();
export type Review = z.infer<typeof reviewSchema>;
export const reviewV2Schema = reviewSchema.extend({
  closure: z.object({ inferenceId: str, actorId: str, actFactId: str,
    evidenceQuotes: z.array(str).min(2), exclusionAssessment: str, verdict: z.enum(['pass', 'revise']) }).strict(),
  questioning: z.object({ meaningfulPress: z.boolean(), revisedTestimony: z.boolean(), stagedReveal: z.boolean(), assessment: str }).strict(),
  leakage: z.object({ authorIdsVisible: z.boolean(), earlyConclusion: z.boolean(), choiceCue: z.boolean(), assessment: str }).strict(),
}).strict();
export type ReviewV2 = z.infer<typeof reviewV2Schema>;
export const reviewPromptVersion = 'review-2.1';

export async function reviewCase(c: Case, replay: { opening: string[]; steps: TraceStep[] }, dir: string, config: ModelConfig) {
  const prompt = `# 独立验收评审 ${reviewPromptVersion}
你是侦探案件的独立批判审查模型，没有参与创作。只输出附带 Schema 的 JSON，不调用工具、改文件或委派。
重点寻找足以破坏核心推理的问题，不把可通关性或作者自述当作推理正确证明。
逐项审查真相/时间线/角色动机/证据来源一致性；每处推理的陈述、证物、必要前提、可靠性与结论强度；合理替代解释；实际呈现的文本；玩家取得必要信息的时机；揭露如何推进调查。内部 truth/solutions/argument 只用于审查作者意图，玩家判断的依据只能来自 replay.opening、某次推理之前的 playerBefore 已获 knowledge/evidence/claims 和之前实际输出的 text。选项本身不能凭空提供从未建立的前提。
对每个 inference 返回独立评审，引用真实陈述和证物文字；premiseAvailability 给出知识条目 ID、实际取得的回放步骤序号（开场为0，steps从1计）和逐字引文。若问题不可修复或前提缺失则 blocking/revise，不能用自白或人物反应倒推推理之前已有证据。检查另一 accepted/distractor 论证是否同样合理，证据是否只支持怀疑却被用来排他定罪。
不要求商业叙事质量、不要求证明案件中未主张的法律事实。${c.version === '2.0' ? '核心实施者归属必须闭合，不能以留待调查结案。' : '允许明确保留不确定性的局部结局。'}微型案件的事实设定可作为故事内前提，但必须说明来源、被玩家看到并保持一致。每项 blocking 指出具体字段、反例及修改建议。minor 可以通过但需记录。发现核心缺陷必须 verdict=revise。
叙事评价引用具体文本，说明人物动机、悬念铺垫、信息揭露和推理反馈，局限真实写明。你是 AI 评价，不代表人类试玩或形式证明。

案件（包含作者层）：\n${JSON.stringify(c)}

实际运行器的通关回放（含每步前的玩家视图）：\n${JSON.stringify(replay)}`;
  const requirements = c.version === '2.0' ? `
这是完整实施者归属的 v2 验收，禁止只认定“材料不实/某人值得调查”便通过。closure 必须核对 resolution 指定的具体行为、truth.culpritId 与 identity 节点的独立归属材料，逐一攻击其他候选人、代做、栽赃、标识转移与遗漏通道等重要替代解释。结局若仍待追查核心行为实施者就是 blocking。
除给定回放外，逐一检查每份 solutions 的最低成功条件。某条回放碰巧提前取得额外证据，不能补足其他合法顺序下成功条件缺少的材料；若反例仍满足最低条件并能被运行器接受，就必须blocking。尤其不能把可转移标签、包装、工具的对应直接等同于原对象或操作者。
questioning 核对实际追问取得必要信息、原陈述被反驳后真正改口、进一步调查和证物在其后开放；不能把新证词和情绪当作实施证明。
leakage 只审查真实 playerBefore/输出，不将作者答案ID出现在作者案件当作公开泄漏。玩家编号与作者ID不同。检查未取得的事实是否出现在开场、观察、问题或选项中；正确项是否靠更长、更谨慎或明显不同的措辞被识别，干扰项需有具体证据诱因。发现完整结论在推理之前已经被旁白给出，或明显答案提示，应 blocking/revise。
必须引用推理前可见的物证及前提来证明身份，不能用作者 truth/attribution 自我解释作证明。允许故事内明确来源的微型规则，但若物理机制或唯一性约束没有足够的可见铺垫则阻断。` : '';
  const schema = c.version === '2.0' ? reviewV2Schema : reviewSchema;
  const raw = await callModel(prompt + requirements, z.toJSONSchema(schema), dir, config);
  const review = schema.parse(JSON.parse(raw));
  await saveJson(join(dir, 'review.json'), review);
  return review;
}

export function reviewAccepted(c: Case, review: Review | ReviewV2): boolean {
  const core = review.verdict === 'pass' && !review.issues.some(x => x.severity === 'blocking') &&
    review.inferenceReviews.length === c.inferences.length &&
    c.inferences.every(i => review.inferenceReviews.filter(r => r.inferenceId === i.id && r.verdict === 'pass').length === 1);
  if (c.version !== '2.0') return core;
  if (!('closure' in review)) return false;
  return core && review.closure.verdict === 'pass' && review.closure.actorId === c.truth.culpritId &&
    review.closure.actFactId === c.resolution.actFactId && review.closure.inferenceId === c.resolution.identityInferenceId &&
    review.questioning.meaningfulPress && review.questioning.revisedTestimony && review.questioning.stagedReveal &&
    !review.leakage.authorIdsVisible && !review.leakage.earlyConclusion && !review.leakage.choiceCue;
}
