import { resolve, join } from 'node:path';
import { readJson, saveJson } from '../src/io.js';
import { generateWithSdk, type SdkManifest } from '../src/sdk-generation.js';

for (const argument of process.argv.slice(2)) {
  const out = resolve(argument), prior = await readJson(join(out, 'manifest.json')) as SdkManifest;
  if (prior.status !== 'failed' || !/Reconnecting|AbortError|timeout|tls handshake/.test(JSON.stringify(prior.attempts.at(-1))))
    throw new Error('仅允许恢复已记录的文字修复模型传输失败');
  try { await readJson(join(out, 'quality-transport-recovery-1.json')); throw new Error('文字修复传输恢复预算已用完'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await saveJson(join(out, 'quality-transport-recovery-1.json'), { priorManifest: prior, budget: 1,
    reason: 'SDK高需求 Reconnecting 通知处理已修复；保留现文件、会话和总内容预算，仅一次恢复。' });
  const result = await generateWithSdk({ theme: prior.theme, constraints: prior.constraints, out, resume: true,
    settings: prior.settings, maxRepairs: prior.maxRepairs, maxDesignRepairs: prior.maxDesignRepairs,
    feedback: { failureKind: 'model-transport', message: '上一轮流/超时未完成，原有文件与质量修复进度已经保留。继续本轮剩余工作；若文件已经修好，只提交目前文件回执，不重写整案。按之前quality-feedback文件检查未关闭问题，可以按需检查并回放。总内容预算没有增加；这次传输恢复仅一次。' } });
  console.log(JSON.stringify({ out, status: result.status, attempt: result.acceptedAttempt }));
}
