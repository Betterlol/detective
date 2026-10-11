import { readFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { caseSchema, jsonSchema } from './model.js';
import { callModel, modelConfig } from './provider.js';
import { audit, inferenceEvidence } from './validate.js';
import { reviewAccepted, reviewCase, reviewPromptVersion } from './review.js';
import { hash, readJson, saveJson } from './io.js';
import { designCase, designPromptVersion } from './design.js';
import { blindPlay } from './blind-player.js';
import { changes } from './experiment-report.js';
import { randomUUID } from 'node:crypto';
import { archivePlayerBinding, repairSource } from './repair-history.js';

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
    attempts: [] as { index: number; kind: string; status: string; caseHash?: string; diagnostics: unknown }[],
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
    const dir = join(input.out, `attempt-${n}`);
    const prompt = `${template}\n\n主题：${manifest.theme}\n约束：${manifest.constraints}\n真相先行设计（保持核心事实与人物，补充可执行取证，不临时换凶手）：${JSON.stringify(design)}\n` +
      (previous ? `\n这是反馈修复调用。保留案件核心主题与已有有效推理，只修改导致失败的内容及受影响文本。不要减弱验收要求，不绕过运行器。返回完整修复案件。\n原案件/输出：${JSON.stringify(previous)}\n检查和评审反馈：${JSON.stringify(feedback)}` :
        feedback ? `此前没有可恢复的案件输出，依据原设计和失败反馈重新生成完整案件：${JSON.stringify(feedback)}` : '自主创作完整新案件，不能读取此前案件。');
    console.log(`[${input.out}] ${n === 0 && !previous ? '生成' : '反馈修复'} attempt-${n}`);
    const attempt: typeof manifest.attempts[number] = { index: n, kind: previous || input.resume ? 'repair' : 'create', status: 'running', diagnostics: null };
    manifest.attempts.push(attempt); await saveJson(join(input.out, 'manifest.json'), manifest);
    let raw = '';
    try {
      if (previous) await saveJson(join(dir, 'repair-input.json'), { sourceHash: hash(previous), feedback });
      raw = await callModel(prompt, jsonSchema, dir, config);
      const data: unknown = JSON.parse(raw);
      if (previous) await saveJson(join(dir, 'repair-diff.json'), { beforeHash: hash(previous), afterHash: hash(data), changes: changes(previous, data) });
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
          console.log(`[${input.out}] 文本评审通过，开始玩家视角模型试玩`);
          const playtest = await blindPlay(c, join(dir, 'player'), config);
          feedback = { review, playerFeedback: playtest };
          if (!playtest.ok) { attempt.status = 'player-failed'; attempt.diagnostics = { reason: '玩家仅凭实际文本未能通关', playtest }; }
          else {
          await saveJson(join(input.out, 'case.json'), c);
          await saveJson(join(input.out, 'audit.json'), result);
          await saveJson(join(input.out, 'replay.json'), result.search.replay);
          await saveJson(join(input.out, 'inference-evidence.json'), inferenceEvidence(c, result.search.replay));
          await saveJson(join(input.out, 'review.json'), review);
          await saveJson(join(input.out, 'playtest.json'), playtest);
          if (input.resume) await archivePlayerBinding(input.out, n);
          attempt.status = 'accepted'; attempt.diagnostics = review.issues;
          manifest.status = 'accepted'; manifest.acceptedAttempt = n; manifest.acceptedCaseHash = hash(c);
          }
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
