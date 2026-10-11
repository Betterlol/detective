import { join, resolve } from 'node:path';
import { readJson, saveJson } from '../src/io.js';
import { generateWithSdk, type SdkManifest } from '../src/sdk-generation.js';
import { experimentReport } from '../src/experiment-report.js';

const root = resolve(process.argv[2] ?? 'experiments/agent-tools-20261011');
const names = process.argv.slice(3);
for (const name of names) {
  if (!/^(theatre|radio|greenhouse)-[12]$/.test(name)) throw new Error('unknown benchmark sample');
  const out = join(root, name), manifest = await readJson(join(out, 'manifest.json')) as SdkManifest;
  if (manifest.status === 'accepted') continue;
  if (manifest.status !== 'failed') throw new Error(`${name} is still running`);
  const last = [...manifest.foundationAttempts, ...manifest.attempts].at(-1);
  if (!/tls handshake|Reconnecting|stream disconnected|timeout|aborted/i.test(JSON.stringify(last))) throw new Error(`${name}: 非传输失败，禁止盲目续跑`);
  try { await readJson(join(out, 'transport-recovery-1.json')); throw new Error(`${name}: 已用完一次传输恢复预算`); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await saveJson(join(out, 'transport-recovery-1.json'), { budget: 1, priorManifest: manifest,
    reason: '旧运行器把 SDK Reconnecting n/5 恢复通知视为终止；修复后只续跑一次，保留原会话、内容与失败记录' });
  console.log(`RECOVER ${name}`);
  const result = await generateWithSdk({ theme: manifest.theme, constraints: manifest.constraints, out, resume: true,
    settings: manifest.settings, maxRepairs: manifest.maxRepairs, maxDesignRepairs: manifest.maxDesignRepairs,
    feedback: { failureKind: 'model-transport', message: 'SDK恢复通知处理已修复，继续原文件与会话。查看已有 foundation-review 反馈，对 blocking 作局部修复，并主动评审当前版本。复杂修改用 apply_patch 或写入本地脚本后执行，避免在 PowerShell -e 内嵌长 JavaScript 字符串。不要仅返回未修复的检查失败。' } });
  console.log(`RESULT ${name} ${result.status}`);
  await experimentReport(root);
}
