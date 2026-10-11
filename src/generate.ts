import { readFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { modelConfig } from './provider.js';
import { audit } from './validate.js';
import { reviewPromptVersion } from './review.js';
import { hash, readJson, saveJson } from './io.js';
import { designCase, designPromptVersion } from './design.js';
import { randomUUID } from 'node:crypto';
import { repairSource } from './repair-history.js';
import { runGenerationAttempt, type GenerationAttempt } from './generation-attempt.js';

export type GenerateInput = { theme: string; constraints: string; out: string; maxRepairs?: number; source?: unknown; injected?: boolean; resume?: boolean; feedback?: unknown };
export async function generate(input: GenerateInput) {
  if (!input.resume) {
    try { await access(join(input.out, 'manifest.json')); throw new Error('输出目录已有实验记录，请换一个目录，避免覆盖历史'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  await mkdir(input.out, { recursive: true });
  const template = await readFile(new URL('../prompts/create-v2.md', import.meta.url), 'utf8');
  const config = modelConfig(); let maxRepairs = input.maxRepairs ?? 2;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 5) throw new Error('maxRepairs 必须为0至5');
  let manifest = { version: 'experiment-2.0', contentVersion: '2.0', theme: input.theme, constraints: input.constraints,
    designPromptVersion, promptVersion: 'create-2.0', promptHash: hash(template), reviewPromptVersion, config, maxRepairs,
    kind: input.injected ? 'injected-defect-repair' : 'natural-generation',
    startedAt: new Date().toISOString(), completedAt: null as string | null, status: 'running',
    attempts: [] as GenerationAttempt[],
    acceptedAttempt: null as number | null, acceptedCaseHash: null as string | null };
  let design;
  let previous = input.source, feedback: unknown = previous ? audit(previous) : null;
  let startAttempt = 0;
  if (input.resume) {
    manifest = await readJson(join(input.out, 'manifest.json')) as typeof manifest;
    if (manifest.version !== 'experiment-2.0' || manifest.status === 'running' || !input.feedback) throw new Error('续修需要已停止的v2实验及具体反馈');
    startAttempt = manifest.attempts.length; maxRepairs = input.maxRepairs ?? manifest.maxRepairs;
    if (!Number.isInteger(maxRepairs) || maxRepairs < startAttempt || maxRepairs > 5) throw new Error('已无修复预算；指定不超过5且足够的repairs');
    previous = await repairSource(input.out, manifest.attempts);
    feedback = { audit: previous ? audit(previous) : null, additionalReview: input.feedback,
      priorAttempts: manifest.attempts.map(x => ({ index: x.index, status: x.status, diagnostics: x.diagnostics })) };
    design = await readJson(join(input.out, 'design', 'design.json'));
    await saveJson(join(input.out, `resume-${startAttempt}-${randomUUID()}.json`), { at: new Date().toISOString(), priorManifest: manifest, feedback: input.feedback, config });
    if (manifest.acceptedAttempt !== null) {
      const prior = manifest.attempts.find(x => x.index === manifest.acceptedAttempt)!;
      prior.status = 'additional-review-failed'; prior.diagnostics = { priorDiagnostics: prior.diagnostics, additionalReview: input.feedback };
    }
    manifest.status = 'running'; manifest.acceptedAttempt = null; manifest.acceptedCaseHash = null;
    manifest.completedAt = null; manifest.maxRepairs = maxRepairs; manifest.config = config; manifest.reviewPromptVersion = reviewPromptVersion;
  } else {
    await saveJson(join(input.out, 'manifest.json'), manifest);
    console.log(`[${input.out}] 真相与身份论证设计`);
    try { design = await designCase(input.theme, input.constraints, join(input.out, 'design'), config, input.source); }
    catch (e) { manifest.status = 'failed'; manifest.completedAt = new Date().toISOString();
      await saveJson(join(input.out, 'design-failure.json'), { error: String(e) });
      await saveJson(join(input.out, 'manifest.json'), manifest); return manifest; }
    if (previous) { await saveJson(join(input.out, 'source.json'), previous); await saveJson(join(input.out, 'source-audit.json'), feedback); }
  }
  for (let n = startAttempt; n <= maxRepairs; n++) {
    console.log(`[${input.out}] ${n === 0 && !previous ? '创建' : '反馈修复'} attempt-${n}`);
    const attempt: GenerationAttempt = { index: n, kind: previous || input.resume ? 'repair' : 'create', status: 'running', diagnostics: null };
    manifest.attempts.push(attempt);
    await saveJson(join(input.out, 'manifest.json'), manifest);

    const result = await runGenerationAttempt({ outputDir: input.out, attempt, theme: manifest.theme,
      constraints: manifest.constraints, template, design, previous, feedback, config, resume: input.resume ?? false });
    previous = result.previous;
    feedback = result.feedback;
    if (result.acceptedCaseHash) {
      manifest.status = 'accepted';
      manifest.acceptedAttempt = n;
      manifest.acceptedCaseHash = result.acceptedCaseHash;
    }
    await saveJson(join(input.out, 'manifest.json'), manifest);
    console.log(`[${input.out}] attempt-${n}: ${attempt.status}`);
    if (manifest.status === 'accepted') break;
    // Transport/auth failures are not case defects; do not spend retries repeating the same request.
    if (attempt.status === 'call-or-parse-failed' && !result.raw) break;
  }
  if (manifest.status !== 'accepted') manifest.status = 'failed';
  manifest.completedAt = new Date().toISOString();
  await saveJson(join(input.out, 'manifest.json'), manifest);
  return manifest;
}
