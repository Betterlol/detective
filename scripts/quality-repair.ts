import { resolve, join } from 'node:path';
import { generateWithSdk, type SdkManifest } from '../src/sdk-generation.js';
import { readJson, saveJson, hash } from '../src/io.js';

const out = resolve(process.argv[2]!);
const feedback = await readJson(process.argv[3]!);
const prior = await readJson(join(out, 'manifest.json')) as SdkManifest;
if (prior.status !== 'accepted') throw new Error('质量续修只接收已提交且通过程序检查的案件');
await saveJson(join(out, `manual-quality-input-${prior.attempts.length}.json`), {
  caseHash: hash(await readJson(join(out, 'case.json'))), feedback,
  method: '直接阅读玩家实际回放及公开视图；没有调用 caseReview 或 blindPlaytest 模型' });
const result = await generateWithSdk({ theme: prior.theme, constraints: prior.constraints, out, resume: true,
  feedback, settings: prior.settings, maxRepairs: prior.maxRepairs, maxDesignRepairs: prior.maxDesignRepairs });
console.log(JSON.stringify({ status: result.status, acceptedAttempt: result.acceptedAttempt }));
