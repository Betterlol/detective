import { join, resolve } from 'node:path';
import { readJson, saveJson } from '../src/io.js';
import { generateWithSdk, type SdkManifest } from '../src/sdk-generation.js';
import { experimentReport } from '../src/experiment-report.js';

const root = resolve(process.argv[2] ?? 'experiments/agent-tools-20261011');
const names = ['theatre-1', 'theatre-2', 'radio-1', 'radio-2', 'greenhouse-1', 'greenhouse-2'];
let cursor = 0;
async function worker() {
  for (;;) {
    const name = names[cursor++]; if (!name) return;
    const out = join(root, name), prior = await readJson(join(out, 'manifest.json')) as SdkManifest;
    if (prior.status === 'accepted') continue;
    if (prior.status === 'running') { console.log(`SKIP RUNNING ${name}`); continue; }
    if (prior.status !== 'failed') throw new Error(`${name}: unknown status`);
    try { await readJson(join(out, 'final-bounded-recovery.json')); console.log(`BUDGET USED ${name}`); continue; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await saveJson(join(out, 'final-bounded-recovery.json'), { priorManifest: prior,
      reason: '试运行显示3次设计评审不足；保留全部失败，将总设计修复上限固定为5（最多6次不同版本评审），案件修复上限3。最终只续跑一次，无兜底模型和无限重试。' });
    const settings = { ...prior.settings, generation: { ...prior.settings.generation, maxDesignRepairs: 5, maxRepairs: 3 } };
    console.log(`FINAL ${name}`);
    const result = await generateWithSdk({ theme: prior.theme, constraints: prior.constraints, out, resume: true,
      settings, maxDesignRepairs: 5, maxRepairs: 3,
      feedback: { message: '应用工具接入及长评审处理已修复。保留原有文件，做最小局部修复。请使用本轮给出的工具，设计评审当前版本通过后提交；只有minor而整体pass时无需重写设计。设计总修复上限5（不是额外5），不同版本评审总上限6；完整案件总修复上限3。不得放宽证据或删除必要推理。设计阶段回执artifactPath=design.json，无需申请额外设计修订；复杂编辑用apply_patch或本地脚本，等待长工具结束。' } });
    console.log(`FINAL RESULT ${name} ${result.status}`);
    await experimentReport(root);
  }
}
await Promise.all([worker(), worker()]);
