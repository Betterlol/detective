import { z } from 'zod';
import { callModel, type ModelConfig } from './provider.js';
import { saveJson } from './io.js';
import { join } from 'node:path';

const text = z.string().min(1);
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const designSchema = z.object({
  title: text, theme: text, coreAct: text,
  actor: z.object({ id, name: text, motive: text }).strict(),
  suspects: z.array(z.object({ id, name: text, role: text, apparentSuspicion: text, exclusionMaterial: text }).strict()).min(2).max(4),
  truthFacts: z.array(z.object({ id, text }).strict()).min(4).max(14),
  timeline: z.array(z.object({ time: text, actorId: id, location: text, text }).strict()).min(3).max(8),
  mechanism: z.object({ description: text, physicalConstraints: z.array(text).min(1), materialEvidence: z.array(text).min(2) }).strict(),
  identityArgument: z.object({ independentObservations: z.array(text).min(2), causalAttribution: text,
    excludedAlternatives: z.array(z.object({ suspectId: id, hypothesis: text, rebuttal: text, source: text }).strict()).min(1) }).strict(),
  testimonyEvolution: z.array(z.object({ characterId: id, originalClaim: text, pressedDetail: text,
    contradictionEvidence: z.array(text).min(1), revision: text, nextInvestigation: text }).strict()).min(1).max(3),
  revealPlan: z.array(z.object({ question: text, availableEvidence: z.array(text).min(1), warrantedConclusion: text, nextStep: text }).strict()).min(3).max(5),
  closure: text, risks: z.array(text).min(1),
}).strict();
export type Design = z.infer<typeof designSchema>;
export const designPromptVersion = 'truth-2.0';
export async function designCase(theme: string, constraints: string, dir: string, config: ModelConfig, source?: unknown) {
  const prompt = `# 真相先行 ${designPromptVersion}
只创作侦探案件的设计 JSON，符合所给 Schema。中文原创。不调用工具、不改文件、不委派。
主题：${theme}\n约束：${constraints}
先确定具体核心行为、实际实施者、因果机制与时间线，再倒推三到四步玩家推理：可核验的证词矛盾→新增取证与机制→独立材料证明实施者身份。不是模板换皮。
为身份归属准备至少两类可核对的观察；门禁卡、签名、接触机会、动机或自白均不能单独代替亲手实施的证明。若依赖排他通道、唯一痕迹、时间窗口或物品不可能转交，必须交代实际可取证的限制和来源，排除其他嫌疑人、代做与栽赃等重要替代解释。合理微型案件无需神奇技术或复杂科学。
所有核心结论均由推理前能够取得的材料支持。独立验证员会尝试攻击你的身份论证，故“同款工具”“共享钥匙”“账号记录”都不自动等于其主人亲自实施。
必须有追问获得必要前提、反驳后修订的证词和据此开放的新调查。第一次反驳不能提前证明尚待调查的机制，证人改口不能当成最终定罪材料。结局必须解决开场核心谜题和实际实施者，不以“继续追查谁做的”结尾。外围细节可以保留。
规模控制：2-3位嫌疑人、2-3地点、4-6证物、6-8普通调查、1-2追问、3-4推理节点。角色语气和隐藏动机有区别，疑点有铺垫。
这是创作设计阶段，不要求运行字段；下一阶段会把它编译成确定性游戏，须给足有趣且可公平呈现的材料。
${source ? `已有案件（需要升级，不可照搬不完整的结案）：${JSON.stringify(source)}` : ''}`;
  const raw = await callModel(prompt, z.toJSONSchema(designSchema), dir, config);
  const design = designSchema.parse(JSON.parse(raw));
  await saveJson(join(dir, 'design.json'), design); return design;
}
