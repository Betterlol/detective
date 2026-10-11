import { join } from 'node:path';
import { caseSchema, jsonSchema } from './model.js';
import { callModel, type ModelConfig } from './provider.js';
import { audit } from './validate.js';
import { hash, saveJson } from './io.js';
import { changes } from './experiment-report.js';
import type { DetectiveConfig } from './config.js';
import { runCaseQualityGates } from './case-quality.js';

export type GenerationAttempt = { index: number; kind: string; status: string; caseHash?: string; diagnostics: unknown; skippedMechanisms?: string[] };
export type RunAttemptInput = {
  outputDir: string;
  attempt: GenerationAttempt;
  theme: string;
  constraints: string;
  template: string;
  design: unknown;
  previous: unknown;
  feedback: unknown;
  config: ModelConfig;
  settings: DetectiveConfig;
  resume: boolean;
};
export type RunAttemptResult = {
  attempt: GenerationAttempt;
  previous: unknown;
  feedback: unknown;
  raw: string;
  acceptedCaseHash: string | null;
};

export async function runGenerationAttempt(input: RunAttemptInput): Promise<RunAttemptResult> {
  const { attempt } = input;
  const attemptDir = join(input.outputDir, `attempt-${attempt.index}`);
  const prompt = `${input.template}\n\n主题：${input.theme}\n约束：${input.constraints}\n案件设计（须保持角色和核心事实，转化为可执行取证与推理节点）：${JSON.stringify(input.design)}\n` +
    (input.previous ? `\n这是反馈修复尝试。仅根据诊断修复失败的数据及受影响内容，不要删除失败前有效设计，不得绕过验证；修复后仍须满足所有要求。\n原案件/反馈：${JSON.stringify(input.previous)}\n最新诊断：${JSON.stringify(input.feedback)}` :
      input.feedback ? `此前没有可恢复的案件。结合原设计和失败反馈创作可执行新案件，并继续满足全部要求。\n${JSON.stringify(input.feedback)}` : '请创作一个全新案件并遵循以上设计。');
  let raw = '';
  let previous = input.previous;
  let feedback = input.feedback;
  let acceptedCaseHash: string | null = null;
  try {
    if (previous) await saveJson(join(attemptDir, 'repair-input.json'), { sourceHash: hash(previous), feedback });
    raw = await callModel(prompt, jsonSchema, attemptDir, input.config);
    const data: unknown = JSON.parse(raw);
    if (previous) await saveJson(join(attemptDir, 'repair-diff.json'), { beforeHash: hash(previous), afterHash: hash(data), changes: changes(previous, data) });
    previous = data;
    await saveJson(join(attemptDir, 'case.json'), data);
    attempt.caseHash = hash(data);

    const validation = audit(data, input.settings.validation.searchStateLimit);
    await saveJson(join(attemptDir, 'audit.json'), validation);
    feedback = validation;
    if (!validation.ok || !validation.search?.replay) {
      attempt.status = 'validation-failed';
      attempt.diagnostics = validation.issues;
      return { attempt, previous, feedback, raw, acceptedCaseHash };
    }

    const c = caseSchema.parse(data);
    console.log(`[${input.outputDir}] ${validation.search.states} 个状态搜索通过；按配置继续评审和试玩`);
    const quality = await runCaseQualityGates({
      caseData: c,
      trace: validation.search.replay,
      audit: validation,
      attempt,
      attemptDirectory: attemptDir,
      outputDirectory: input.outputDir,
      config: input.config,
      settings: input.settings,
      resume: input.resume,
    });
    if (attempt.status === 'review-failed') feedback = { auditIssues: validation.issues, review: quality.review };
    else if (input.settings.workflow.blindPlaytest)
      feedback = { review: quality.review ?? 'skipped', playerFeedback: quality.playtest };
    else feedback = { review: quality.review ?? 'skipped', blindPlaytest: 'skipped' };
    if (!quality.accepted) return { attempt, previous, feedback, raw, acceptedCaseHash };
    acceptedCaseHash = hash(c);
  } catch (e) {
    attempt.status = 'call-or-parse-failed';
    attempt.diagnostics = String(e);
    feedback = { error: String(e) };
    if (raw) previous = raw;
  }
  return { attempt, previous, feedback, raw, acceptedCaseHash };
}
