import { readFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { caseSchema, jsonSchema } from './model.js';
import { callModel, modelConfig } from './provider.js';
import { audit, inferenceEvidence } from './validate.js';
import { reviewAccepted, reviewCase, reviewPromptVersion } from './review.js';
import { hash, saveJson } from './io.js';

export type GenerateInput = { theme: string; constraints: string; out: string; maxRepairs?: number; source?: unknown; injected?: boolean };
export async function generate(input: GenerateInput) {
  try { await access(join(input.out, 'manifest.json')); throw new Error('输出目录已有实验记录，请换一个目录，避免覆盖历史'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await mkdir(input.out, { recursive: true });
  const template = await readFile(new URL('../prompts/create.md', import.meta.url), 'utf8');
  const config = modelConfig(), maxRepairs = input.maxRepairs ?? 2;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 5) throw new Error('maxRepairs 必须为0至5');
  const manifest = { version: 'experiment-1.0', theme: input.theme, constraints: input.constraints,
    promptVersion: 'create-1.0', promptHash: hash(template), reviewPromptVersion, config, maxRepairs,
    kind: input.injected ? 'injected-defect-repair' : 'natural-generation',
    startedAt: new Date().toISOString(), completedAt: null as string | null, status: 'running',
    attempts: [] as { index: number; kind: string; status: string; caseHash?: string; diagnostics: unknown }[],
    acceptedAttempt: null as number | null, acceptedCaseHash: null as string | null };
  await saveJson(join(input.out, 'manifest.json'), manifest);
  let previous = input.source, feedback: unknown = previous ? audit(previous) : null;
  if (previous) { await saveJson(join(input.out, 'source.json'), previous); await saveJson(join(input.out, 'source-audit.json'), feedback); }
  for (let n = 0; n <= maxRepairs; n++) {
    const dir = join(input.out, `attempt-${n}`);
    const prompt = `${template}\n\n主题：${input.theme}\n约束：${input.constraints}\n` +
      (previous ? `\n这是反馈修复调用。保留案件核心主题与已有有效推理，只修改导致失败的内容及受影响文本。不要减弱验收要求，不绕过运行器。返回完整修复案件。\n原案件/输出：${JSON.stringify(previous)}\n检查和评审反馈：${JSON.stringify(feedback)}` : '自主创作完整新案件，不能读取此前案件。');
    console.log(`[${input.out}] ${n === 0 && !previous ? '生成' : '反馈修复'} attempt-${n}`);
    const attempt: typeof manifest.attempts[number] = { index: n, kind: previous ? 'repair' : 'create', status: 'running', diagnostics: null };
    manifest.attempts.push(attempt); await saveJson(join(input.out, 'manifest.json'), manifest);
    let raw = '';
    try {
      raw = await callModel(prompt, jsonSchema, dir, config);
      const data: unknown = JSON.parse(raw);
      previous = data; await saveJson(join(dir, 'case.json'), data); attempt.caseHash = hash(data);
      const result = audit(data); await saveJson(join(dir, 'audit.json'), result);
      feedback = result;
      if (!result.ok || !result.search?.replay) { attempt.status = 'validation-failed'; attempt.diagnostics = result.issues; }
      else {
        const c = caseSchema.parse(data);
        console.log(`[${input.out}] ${result.search.states} 状态检查通过，开始独立文本评审`);
        const review = await reviewCase(c, result.search.replay, join(dir, 'review'), config);
        feedback = { auditIssues: result.issues, review };
        if (!reviewAccepted(c, review)) { attempt.status = 'review-failed'; attempt.diagnostics = review; }
        else {
          attempt.status = 'accepted'; attempt.diagnostics = review.issues;
          manifest.status = 'accepted'; manifest.acceptedAttempt = n; manifest.acceptedCaseHash = hash(c);
          await saveJson(join(input.out, 'case.json'), c);
          await saveJson(join(input.out, 'audit.json'), result);
          await saveJson(join(input.out, 'replay.json'), result.search.replay);
          await saveJson(join(input.out, 'inference-evidence.json'), inferenceEvidence(c, result.search.replay));
          await saveJson(join(input.out, 'review.json'), review);
        }
      }
    } catch (e) {
      attempt.status = 'call-or-parse-failed'; attempt.diagnostics = String(e);
      feedback = { error: String(e) }; if (raw) previous = raw;
    }
    await saveJson(join(input.out, 'manifest.json'), manifest);
    console.log(`[${input.out}] attempt-${n}: ${attempt.status}`);
    if (manifest.status === 'accepted') break;
    // Transport/auth failures are not case defects; do not spend retries repeating the same request.
    if (attempt.status === 'call-or-parse-failed' && !raw) break;
  }
  if (manifest.status !== 'accepted') manifest.status = 'failed';
  manifest.completedAt = new Date().toISOString();
  await saveJson(join(input.out, 'manifest.json'), manifest);
  return manifest;
}
