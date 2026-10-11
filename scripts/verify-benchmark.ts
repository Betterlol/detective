import { join, resolve } from 'node:path';
import { readJson, saveJson, hash } from '../src/io.js';
import { readFile } from 'node:fs/promises';
import { verifyAcceptedExperiment } from '../src/experiment-verification.js';
import type { SdkManifest } from '../src/sdk-generation.js';
import { usedBudget } from '../src/sdk-generation-utils.js';
import { caseV2Schema } from '../src/model.js';
import { mutationChecks } from '../src/acceptance.js';
import { experimentReport } from '../src/experiment-report.js';

const root = resolve(process.argv[2] ?? 'experiments/agent-tools-20261011');
const names = ['theatre-1', 'theatre-2', 'radio-1', 'radio-2', 'greenhouse-1', 'greenhouse-2'];
const results = [], problems: string[] = [];
const threads = new Set<string>();
for (const name of names) {
  const directory = join(root, name);
  try {
    const manifest = await readJson(join(directory, 'manifest.json')) as SdkManifest;
    if (manifest.config.model !== 'gpt-6-luna' || manifest.config.reasoningEffort !== 'high') throw new Error('model policy mismatch');
    if (!manifest.authorThreadId || threads.has(manifest.authorThreadId)) throw new Error('六案未使用独立作者会话');
    threads.add(manifest.authorThreadId);
    if (manifest.settings.workflow.caseReview || manifest.settings.workflow.blindPlaytest) throw new Error('禁止的评审/盲测被开启');
    if (usedBudget(manifest.attempts) > manifest.maxRepairs + 1 || usedBudget(manifest.foundationAttempts) > manifest.maxDesignRepairs + 1)
      throw new Error('内容修复预算超限');
    if (manifest.status !== 'accepted') throw new Error(`尚未通过：${manifest.status}`);
    const verified = await verifyAcceptedExperiment(directory, name, manifest, false, manifest.settings.validation.searchStateLimit);
    if (verified.problem) throw new Error(verified.problem);
    const c = caseV2Schema.parse(await readJson(join(directory, 'case.json')));
    const quality = await readJson(join(directory, 'quality-audit.json')) as { verdict: string; caseHash: string; replayHash: string; exportHash: string };
    if (quality.verdict !== 'pass-with-minor' || quality.caseHash !== hash(c) ||
      quality.replayHash !== hash(await readJson(join(directory, 'replay.json'))) ||
      quality.exportHash !== hash(await readFile(join(directory, 'player-replay.md'), 'utf8')))
      throw new Error('逐案质量判断未绑定当前案件与玩家回放');
    const mutations = await mutationChecks(c, join(root, 'regression', name), manifest.settings.validation.searchStateLimit);
    if (!mutations.ok) throw new Error('关键缺陷注入漏检');
    results.push({ name, ok: true, ...verified.caseSummary, quality: quality.verdict, mutations: mutations.results.map(x => ({ name: x.name, detected: x.detected })) });
  } catch (e) { problems.push(`${name}: ${String(e)}`); results.push({ name, ok: false, error: String(e) }); }
}
const report = await experimentReport(root);
const result = { ok: problems.length === 0 && results.length === 6, results, problems, rates: report.rates,
  note: '程序独立复验、穷尽搜索、来源绑定及关键缺陷注入；逐案自然语言质量判断另见质量报告，不能由此推定。' };
await saveJson(join(root, 'benchmark-verification.json'), result);
console.log(JSON.stringify({ ok: result.ok, problems }));
if (!result.ok) process.exitCode = 1;
