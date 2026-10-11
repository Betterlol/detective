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
export const reviewPromptVersion = 'review-1.0';

export async function reviewCase(c: Case, replay: { opening: string[]; steps: TraceStep[] }, dir: string, config: ModelConfig) {
  const prompt = `# 独立验收评审 ${reviewPromptVersion}
你是侦探案件的独立批判审查模型，没有参与创作。只输出附带 Schema 的 JSON，不调用工具、改文件或委派。
重点寻找足以破坏核心推理的问题，不把可通关性或作者自述当作推理正确证明。
逐项审查真相/时间线/角色动机/证据来源一致性；每处推理的陈述、证物、必要前提、可靠性与结论强度；合理替代解释；实际呈现的文本；玩家取得必要信息的时机；揭露如何推进调查。内部 truth/solutions/argument 只用于审查作者意图，玩家判断的依据只能来自 replay.opening、某次推理之前的 playerBefore 已获 knowledge/evidence/claims 和之前实际输出的 text。选项本身不能凭空提供从未建立的前提。
对每个 inference 返回独立评审，引用真实陈述和证物文字；premiseAvailability 给出知识条目 ID、实际取得的回放步骤序号（开场为0，steps从1计）和逐字引文。若问题不可修复或前提缺失则 blocking/revise，不能用自白或人物反应倒推推理之前已有证据。检查另一 accepted/distractor 论证是否同样合理，证据是否只支持怀疑却被用来排他定罪。
不要求商业叙事质量、不要求证明无犯罪案件中未主张的法律事实。允许明确保留不确定性的结局。微型案件的事实设定可作为故事内前提，但必须说明来源、被玩家看到并保持一致。每项 blocking 指出具体字段、反例及修改建议。minor 可以通过但需记录。发现核心缺陷必须 verdict=revise。
叙事评价引用具体文本，说明人物动机、悬念铺垫、信息揭露和推理反馈，局限真实写明。你是 AI 评价，不代表人类试玩或形式证明。

案件（包含作者层）：\n${JSON.stringify(c)}

实际运行器的通关回放（含每步前的玩家视图）：\n${JSON.stringify(replay)}`;
  const raw = await callModel(prompt, z.toJSONSchema(reviewSchema), dir, config);
  const review = reviewSchema.parse(JSON.parse(raw));
  await saveJson(join(dir, 'review.json'), review);
  return review;
}

export function reviewAccepted(c: Case, review: Review): boolean {
  return review.verdict === 'pass' && !review.issues.some(x => x.severity === 'blocking') &&
    review.inferenceReviews.length === c.inferences.length &&
    c.inferences.every(i => review.inferenceReviews.filter(r => r.inferenceId === i.id && r.verdict === 'pass').length === 1);
}
