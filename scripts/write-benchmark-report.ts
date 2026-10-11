import { join, resolve } from 'node:path';
import { readJson, saveText } from '../src/io.js';
import { experimentReport } from '../src/experiment-report.js';
import { usedBudget } from '../src/sdk-generation-utils.js';
import type { SdkManifest } from '../src/sdk-generation.js';

const root = resolve(process.argv[2] ?? 'experiments/agent-tools-20261011');
const report = await experimentReport(root);
const verified = await readJson(join(root, 'benchmark-verification.json')) as {
  ok: boolean; results: { name: string; states: number; probes: number; steps: number; caseHash: string; quality: string }[];
};
if (!verified.ok || verified.results.length !== 6 || verified.results.some(x => x.quality !== 'pass-with-minor')) throw new Error('最终验收尚未完成');
const names = ['theatre-1', 'theatre-2', 'radio-1', 'radio-2', 'greenhouse-1', 'greenhouse-2'];
const totals = { author: 0, sdk: 0, tools: 0, searches: 0, searchMs: 0, toolMs: 0, cache: 0, boundaryCache: 0,
  verifySearch: 0, verifyMs: 0, input: 0, cachedInput: 0, output: 0, reasoning: 0, missing: 0 };
const rows: string[] = [], metrics: string[] = [], tokenRows: string[] = [], qualitySections: string[] = [], histories: string[] = [];
for (const name of names) {
  const e = report.experiments.find(x => x.directory === name)!, m = e.metrics;
  const manifest = await readJson(join(root, name, 'manifest.json')) as SdkManifest;
  const v = verified.results.find(x => x.name === name)!;
  const q = await readJson(join(root, name, 'quality-audit.json')) as {
    premises: string; identity: string; alternatives: string; revealAndPress: string; proseAndLeakage: string; remaining: string[];
  };
  rows.push(`| [${name}](${name}/player-replay.md) | ${e.firstContentCheckPassed ? '通过' : '失败'} | ${e.firstFullCheckPassed ? '通过' : '失败'} | 通过 | ${usedBudget(manifest.foundationAttempts) - 1}/5 | ${usedBudget(manifest.attempts) - 1}/3 | ${v.states}/${v.probes} | ${v.steps} | 通过，保留轻微问题 |`);
  metrics.push(`| ${name} | ${m.authorTurns} | ${m.sdkTurns} | ${m.counts.design}/${m.counts.quick}/${m.counts.case}/${m.counts.replay}/${m.counts['foundation-review']} | ${m.searches} | ${m.searchMs} | ${m.cacheHits}/${m.boundaryCacheHits} | ${m.toolMs} | ${(m.wallMs! / 60000).toFixed(1)} |`);
  const tokens = m.tokenTotals;
  tokenRows.push(`| ${name} | ${tokens.input_tokens ?? 0} | ${tokens.cached_input_tokens ?? 0} | ${tokens.output_tokens ?? 0} | ${tokens.reasoning_output_tokens ?? 0} | ${m.usageMissingCalls} |`);
  totals.author += m.authorTurns; totals.sdk += m.sdkTurns; totals.tools += m.toolCalls; totals.searches += m.searches;
  totals.searchMs += m.searchMs; totals.toolMs += m.toolMs; totals.cache += m.cacheHits; totals.boundaryCache += m.boundaryCacheHits;
  totals.verifySearch += m.verificationSearches; totals.verifyMs += m.verificationMs; totals.missing += m.usageMissingCalls;
  totals.input += tokens.input_tokens ?? 0; totals.cachedInput += tokens.cached_input_tokens ?? 0;
  totals.output += tokens.output_tokens ?? 0; totals.reasoning += tokens.reasoning_output_tokens ?? 0;
  qualitySections.push(`### ${name}\n\n- 前提顺序：${q.premises}\n- 实施者：${q.identity}\n- 替代解释：${q.alternatives}\n- 揭露与追问：${q.revealAndPress}\n- 文字与泄漏：${q.proseAndLeakage}\n- 遗留：${q.remaining.join('；')}\n\n案件哈希：\`${v.caseHash}\`。完整判断与回放绑定见 [quality-audit.json](${name}/quality-audit.json)。`);
  histories.push(`### ${name} 的记录\n\n设计提交：${manifest.foundationAttempts.map(x => `${x.index}:${x.status}${x.consumesBudget ? '〔内容预算〕' : '〔不计内容预算〕'}`).join(' → ')}。\n\n案件提交：${manifest.attempts.map(x => `${x.index}:${x.status}${x.consumesBudget ? '〔内容预算〕' : '〔不计内容预算〕'}`).join(' → ')}。\n\n内层失败检查：${e.toolFailures.map(x => `${x.mode}/${x.failureKind}：${x.issues.map(i => i.code).join(',')}`).join('；') || '无'}。\n\n恢复快照：${e.resumes.map(x => `[${x.snapshot}](${name}/${x.snapshot})`).join('、')}。每轮原始事件、输入输出和修复差异保留于对应目录；每次工具输入与报告保留在 [工具历史](${name}/author/.detective-tools/calls.jsonl)，具体 shell 失败输出与传输状态见 [总报告](experiment-report.json)。`);
}

const text = `# 持续作者与工具工作流实验验收（2026-10-11）

## 结果和范围

三个主题（剧场换铃、广播剪接、温室手动供水）各两个独立作者线程，六案均由真实 \`gpt-6-luna\` / \`high\` 生成。当前案件均通过全部规则、穷尽搜索、设计一致性、来源和公开前提复验；逐案玩家文字直接审阅后均达到本轮验收，保留轻微问题。没有调用 caseReview 或 blindPlaytest，模型玩家调用数为0。设计评审由作者主动请求，实际执行于隔离、无工具会话。

**首次内容检查4/6（66.7%），首次完整工具检查3/6（50%），首次案件提交6/6（100%），最终程序通过6/6（100%）。首次玩家文字审阅0/6，局部修复后的最终质量6/6。** 首次提交发生于作者完成内层检查/修复之后，不能把它解释为首稿质量100%或首次设计流程100%。首次工具失败全部计入，未用最终稿替换原始样本。

初始试运行的设计/案件修复预算都是2。工具接入和评审协议失败后保留全部记录，仅一次有界续修将**总**设计修复上限设为5、案件上限设为3，不是每次恢复再增加；最终验收按此预算检查。现在默认配置采用5/3，仍最多5，不改任何关键规则。表中次数不含首次提交；非内容失败未冒充内容修复。

| 案件 | 首次内容工具 | 首次完整工具 | 首次案件提交 | 设计修复 | 案件修复 | 穷尽状态/探测 | 回放步数 | 最终质量 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## 实际修改与接入

持续作者在同一 SDK thread 读写 design.json/case.json，提交小回执。取消固定 polish 轮次，作者在 build 内自主完善文字。允许同轮准备设计和案件修订，程序先验收设计再检查已准备案件。连续文件编辑不自动触发完整检查或模型评审。

作者实际通过 Node CLI 调用预编译工具：design 检查设计；quick 做所有静态规则和设计一致性；case 做完整规则及搜索；replay 返回真实演出和当时公开视图；foundation-review 主动请求隔离评审。每项有清晰参数和 JSON 反馈。Windows 沙箱不能可靠地再启动 tsx/esbuild 或嵌套 SDK，改由应用预编译、文件 broker 在应用侧启动隔离 SDK。评审请求有唯一标识，旧失败响应不能冒充新响应，旧请求不会自行触发新评审。

提交边界始终由程序负责，先核对实际文件与回执快照。只有真实工具事件、当前案件/设计哈希、搜索上限、当前实现版本与审计哈希一致且搜索穷尽时才复用；否则重新完整检查。quick 和作者自称成功均不能代替验收。校验源码或编译版本变化也使旧缓存失效。详细调用及预算见 [作者工具文档](../../branch_docs/agent-tools-workflow.md)。

prompt 加入观察范围、同一对象前后状态、具体动作归属、历史与当前观察区分、有限结论、后续揭露用途和选项公平检查。新增“每题正确项均唯一最长”的弱提示，不放宽任何硬规则，也不以弱提示代替语义审阅。

## 数据与效果

| 案件 | 作者轮次 | 可观测SDK调用 | design/quick/case/replay/设计评审工具 | 新搜索 | 搜索ms | 工具/提交缓存命中 | 工具ms | 经过分钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${metrics.join('\n')}

合计作者${totals.author}轮、留存可辨识SDK调用${totals.sdk}轮（完成${report.completedCalls}轮），其中隔离设计评审${report.phases.review}轮；工具${totals.tools}次，新搜索${totals.searches}次，总搜索${totals.searchMs}ms，工具等待${totals.toolMs}ms。工具缓存命中${totals.cache}次，提交边界复用${totals.boundaryCache}次。离线复验及缺陷注入另有${totals.verifySearch}次搜索、${totals.verifyMs}ms审计，计入单独统计，未混入生成搜索。

完整/回放工具共57次，只有27次新搜索，其余30次复用同版结果；17次已提交案件检查都复用有效完整结果。71次设计/快速静态工具不启动搜索。六次首次构建均没有固定第二个 polish 轮次，局部修复不要求重输出整案。这些是本批可直接观察的减少重复工作证据；没有同种子旧流程对照，不能声称总体token或端到端耗时降低了某个百分比。

| 案件 | input_tokens | cached_input_tokens | output_tokens | reasoning_output_tokens | 无usage调用 |
| --- | --- | --- | --- | --- | --- |
${tokenRows.join('\n')}
| 合计 | ${totals.input} | ${totals.cachedInput} | ${totals.output} | ${totals.reasoning} | ${totals.missing} |

可见输入缓存比例为${(totals.cachedInput / totals.input * 100).toFixed(2)}%；cache_write_input_tokens在返回的usage中均为0。SDK汇总usage覆盖作者内部多次工具后的模型请求，输入和输出累计很高，保留原值，不把一次SDK轮次当一次底层API请求。内部实际模型请求数、未完成流的token及服务计费没有暴露，不能补成0或宣称精确费用。reasoning单独按原字段记录，不重复相加。极早期同键工具启动失败的部分SDK文件曾被覆盖，原工具失败和恢复快照仍保留；因此调用统计是留存可辨识轮次，不冒充全部底层请求。工具等待包含嵌套设计评审，不能再加模型耗时；经过时间包含排队、恢复和人工审阅等待，并行样本时间也不可直接相加为总工时。

## 失败、修复和有界策略

内容缺陷包括设计遗漏候选排除、before/after对象没有接上、账号/机会代替动作、事实引用或可见前提缺失、改口不可达与软锁、过早揭露、语义越界和选项提示；全部按内容预算处理。工具执行失败包括Windows spawn EPERM、沙箱内tsx/esbuild失败、文件交接与长命令未等完、PowerShell内复杂字符串编辑失败；传输失败包括TLS断流、高需求重连与480秒超时，分别保存诊断，不算成案件逻辑失败。

首批两个剧场样本有两次基础接入恢复，原manifest快照保留；六样本各最多一次总预算续修。仅在已有传输失败证据时做一次生成恢复，质量续修期间每案最多一次传输恢复；三个样本实际用了质量传输恢复。作者同类工具执行问题最多再试2次；各工具有总调用上限、不同设计评审最多6版，模型流内部重连最多5。SDK有界重连通知保存并允许流完成；终止失败/未知错误/超时仍停止，未完成流永不验收。没有自动切换模型、无限追加内容预算或删除必要节点。

文字修复的具体过程：theatre-1先修正早期“没看见”与后期“持续看见”的冲突和机制时间越界，再把“有意隐瞒”缩为证据支持的离场矛盾；一次质量传输失败后在原线程恢复。theatre-2先修正旧铃过早出现在开场、提前得到全部身份材料和题面未来信息，再把当前木壳机制改为有限解释，待后续连续追踪才确认谢幕同一铃。radio-1补上同一工程接缝到导出/队列的连续性，再统一完整引语、历史观察和选项。radio-2补清室内外放、同一卡留槽到播完与预置节目键，经一次超时恢复成功。greenhouse-1把当前完整水路前置到机制之前，明确发现时间来源，后续才取得两处历史动作观察，经一次高需求恢复成功。greenhouse-2把事后流量测试改为能力估算、延后短片来源比对，再修正稳定最长选项，最后删除机制知识中未来目击时刻；用了全部3次案件修复额度。

所有外层失败/修复顺序和内层失败摘要如下；留存的输入输出、反馈、工具历史及repair-diff不删改。

${histories.join('\n\n')}

## 逐案玩家文字判断

判断来自根Agent逐步阅读实际公开回放、当时可选项和推理输出，不是caseReview模型，也没有模拟盲玩家。每案质量记录绑定当前case/replay/export哈希，最终验收拒绝不匹配的记录。这里判断证据支持范围和文字演出；程序通过单独记录。

${qualitySections.join('\n\n')}

## 回归与剩余问题

\`npm run check\`通过，\`npm test\` **62/62**通过。覆盖持续会话、无中间工具提交、提交后文件变化、quick不搜索、回放复用与参数/文件失效、关闭设计评审、文件broker的旧失败响应/被动旧请求、有限重连、所有既有核心引擎与V2规则。

六个最终案件各注入9种缺陷，**54/54检出**：引用悬空、非法效果、证据无法取得、必要前提不可见、普通行动跳过结论、结案跳过身份、身份缺少机制依赖、提前取得修订证词这8类均为阻断错误，共48个；极端选项长度差异是弱提示，共6个，不能把这6项声称为硬阻断。独立完整复验再次确认穷尽搜索、回放重现、前提先得和来源绑定。详见 [benchmark-verification.json](benchmark-verification.json) 与 regression/。

当前没有阻断这六案交付的外部问题，但服务高需求/网络超时仍存在，停止和一次人工/脚本恢复能力已保留；它不等于模型服务可用性保证。首次提交成品的文字审阅通过率仍是0/6，故没有证明无人审阅即可稳定得到自然、公平文案。程序静态规则不能识别所有措辞歧义、未来前提转述或生活可信度；本批用逐案直接审阅补足。连续见证安排与说明重复仍偏集中，greenhouse-2远读小编号的描写尤其可进一步改善。六个微型案件不足以证明长案、多主题、大角色集的广泛稳定性。

复现工具与记录：

\`\`\`powershell
node --import tsx scripts/export-player-replays.ts
node --import tsx scripts/verify-benchmark.ts
node --import tsx scripts/write-benchmark-report.ts
npm run lab -- report experiments/agent-tools-20261011
\`\`\`

\`record-quality-audits.ts\`只归档本轮直接审阅所得、固定哈希的观察，不是给新案件自动打分的评估器；文件变化时应先重新审阅，再提供新判断。
`;
await saveText(join(root, 'QUALITY_REPORT.md'), text);
console.log('QUALITY_REPORT.md 已写入。');
