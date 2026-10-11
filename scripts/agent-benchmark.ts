import { join, resolve } from 'node:path';
import { generateWithSdk } from '../src/sdk-generation.js';
import { loadDetectiveConfig } from '../src/config.js';
import { saveJson } from '../src/io.js';
import { experimentReport } from '../src/experiment-report.js';
import { readJson } from '../src/io.js';

const root = resolve(process.argv[2] ?? 'experiments/agent-tools-20261011');
const settings = await loadDetectiveConfig();
if (settings.workflow.caseReview || settings.workflow.blindPlaytest) throw new Error('本实验禁止 caseReview/blindPlaytest');
const themes = [
  { id: 'theatre', theme: '小剧场道具调换：一件用于谢幕的旧道具在演出间隙被换成仿品' },
  { id: 'radio', theme: '社区广播录音被局部剪接：一次公开播报前有人改变了原始访谈的意思' },
  { id: 'greenhouse', theme: '温室手动灌溉机构被改变：一床试验苗在交班后遭到异常淹水' },
];
const jobs = themes.flatMap(t => [1, 2].map(n => ({ ...t, id: `${t.id}-${n}` })));
const results: unknown[] = [];
let cursor = 0;
async function worker() {
  for (;;) {
    const job = jobs[cursor++]; if (!job) break;
    console.log(`START ${job.id}`);
    try {
      let prior;
      try { prior = await readJson(join(root, job.id, 'manifest.json')) as { status: string }; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (prior?.status === 'accepted') { results.push({ id: job.id, status: 'accepted-existing' }); continue; }
      const result = await generateWithSdk({ theme: job.theme, out: join(root, job.id), settings, maxRepairs: 2, maxDesignRepairs: 2,
        resume: !!prior, feedback: prior ? { failureKind: 'tool-execution', message: '应用已修复 Windows 沙箱 spawn EPERM：检查工具现在是预编译的 dist/author-tools.js，不再启动 tsx/esbuild；foundation-review 通过文件 broker 请求隔离评审。请使用本轮给出的新工具命令，原设计保留，重新调用评审，不重写案件。' } : undefined,
        constraints: '原创微型中文案件。2-3嫌疑人、2地点、4-5证物、6普通调查、1必要追问、3核心推理（矛盾/机制/身份）。保留完整证据公平要求和全部必要推理；主张强度不超过已取得材料。普通现场观察，不依赖魔法鉴定或全知监控。观察明确对象、动作与时间范围；角色有不同语气。' });
      results.push({ id: job.id, status: result.status, acceptedAttempt: result.acceptedAttempt });
      console.log(`DONE ${job.id} ${result.status}`);
    } catch (e) { results.push({ id: job.id, status: 'execution-failed', error: String(e) }); console.log(`FAILED ${job.id} ${e}`); }
    await saveJson(join(root, 'batch.json'), { jobs, results, settings, budget: { contentRepairs: 2, designRepairs: 2, transportAutomaticRetries: 0 } });
  }
}
await Promise.all([worker(), worker()]);
await experimentReport(root);
