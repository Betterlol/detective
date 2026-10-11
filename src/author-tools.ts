import { appendFile, lstat, realpath, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDesign, designConsistency } from './design-validation.js';
import { audit, validate } from './validate.js';
import { caseV2Schema } from './model.js';
import { hash, readJson, saveJson } from './io.js';
import type { Issue } from './validation-types.js';
import { defaultDetectiveConfig, type DetectiveConfig } from './config.js';
import { validationKey } from './validation-cache.js';
import { reviewDesign, designReviewAccepted, designReviewPromptVersion } from './design-review.js';
import { modelConfig } from './provider.js';
import { requestFoundationReview, foundationReviewKey } from './foundation-broker.js';

export const toolMarker = 'detective-validator-2.0';
export type ToolMode = 'design' | 'quick' | 'case' | 'replay' | 'foundation-review';
export type ToolReport = { tool: string; mode: ToolMode; workspace: string; ok: boolean; issues: Issue[];
  designHash: string | null; caseHash: string | null; states?: number; key?: string; auditHash?: string;
  searchStateLimit?: number; cacheHit?: boolean; searchCount?: number; elapsedMs?: number; searchMs?: number;
  failureKind?: 'content' | 'tool-execution' | 'model-transport'; reviewDirectory?: string;
  review?: Awaited<ReturnType<typeof reviewDesign>>; skipped?: boolean;
  replay?: { opening: string[]; ended: boolean; steps: { command: unknown; text: string[]; playerBefore?: unknown }[] } | null };
type CachedAudit = { key: string; audit: ReturnType<typeof audit>; auditHash: string };
const cacheFile = (root: string, key: string) => join(root, '.detective-tools', 'cache', key + '.json');

async function recordToolCall(root: string, result: ToolReport, rawDesign?: unknown, rawCase?: unknown) {
  const directory = join(root, '.detective-tools'); await mkdir(directory, { recursive: true });
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await saveJson(join(directory, 'history', id + '.json'), { report: result, design: rawDesign ?? null, case: rawCase ?? null });
  await appendFile(join(directory, 'calls.jsonl'), JSON.stringify({ ...result, replay: undefined, review: undefined, id }) + '\n', 'utf8');
}

export async function readAuthorArtifact(workspace: string, name: 'design.json' | 'case.json') {
  const file = join(workspace, name), stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('作者产物必须是内容目录内的普通 JSON 文件');
  const root = await realpath(workspace), target = await realpath(file);
  if (resolve(target).toLowerCase() !== resolve(join(root, name)).toLowerCase()) throw new Error('作者产物超出内容目录');
  return readJson(file);
}

export async function auditFromEvidence(workspace: string, report: ToolReport | null, rawDesign: unknown, rawCase: unknown, limit: number) {
  if (!report?.ok || !['case', 'replay'].includes(report.mode) || report.designHash !== hash(rawDesign) || report.caseHash !== hash(rawCase) ||
    report.searchStateLimit !== limit || report.key !== await validationKey(hash(rawDesign), hash(rawCase), limit)) return null;
  try {
    const cached = await readJson(cacheFile(workspace, report.key)) as CachedAudit;
    if (cached.key !== report.key || cached.auditHash !== report.auditHash || hash(cached.audit) !== report.auditHash ||
      !cached.audit.ok || !cached.audit.search?.exhaustive) return null;
    return cached.audit;
  } catch { return null; }
}

export async function checkAuthorWorkspace(workspace: string, mode: ToolMode,
  searchStateLimit = defaultDetectiveConfig.validation.searchStateLimit): Promise<ToolReport> {
  const started = Date.now(), root = await realpath(workspace);
  const result: ToolReport = { tool: toolMarker, mode, workspace: root, ok: false, issues: [], designHash: null, caseHash: null,
    searchStateLimit, cacheHit: false, searchCount: 0, searchMs: 0 };
  let rawDesign: unknown, rawCase: unknown;
  try {
    rawDesign = await readAuthorArtifact(root, 'design.json'); result.designHash = hash(rawDesign);
    const d = auditDesign(rawDesign); result.issues = d.issues;
    if (!d.ok || !d.design) return result;
    if (mode === 'design') { result.ok = true; return result; }
    if (mode === 'foundation-review') {
      const manifest = await readJson(join(dirname(root), 'manifest.json')) as { settings: DetectiveConfig; maxDesignRepairs?: number };
      if (!manifest.settings.workflow.foundationReview) { result.ok = true; result.skipped = true; return result; }
      const reviewKey = await foundationReviewKey(result.designHash, manifest.settings);
      const reviewDirectory = join('.detective-tools', 'reviews', reviewKey);
      result.reviewDirectory = reviewDirectory;
      const directory = join(root, reviewDirectory);
      let review: Awaited<ReturnType<typeof reviewDesign>>;
      try { review = await readJson(join(directory, 'review.json')) as typeof review; result.cacheHit = true; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        const prior = await toolHistory(root);
        if (prior.filter(x => x.mode === 'foundation-review' && !x.cacheHit && !x.skipped && x.failureKind !== 'tool-execution' && x.failureKind !== 'model-transport').length >= (manifest.maxDesignRepairs ?? manifest.settings.generation.maxDesignRepairs) + 1)
          throw new Error('设计评审预算已耗尽');
        try { review = await requestFoundationReview(root, rawDesign, manifest.settings); }
        catch (e) { result.failureKind = String(e).includes('model-transport') ? 'model-transport' : 'tool-execution'; throw e; }
      }
      result.review = review; result.ok = designReviewAccepted(d.design, review);
      result.issues = review.issues.map(x => ({ code: 'foundation-review', path: x.path, message: x.message,
        ...(x.severity === 'minor' ? { severity: 'warning' as const } : {}) }));
      for (const section of ['facts', 'mechanism', 'identity', 'revealPlan'] as const) if (review[section].verdict === 'revise')
        result.issues.push({ code: 'foundation-assessment', path: section,
          message: `此项必须修复后重评，不能按 minor 跳过：${review[section].assessment}` });
      return result;
    }
    rawCase = await readAuthorArtifact(root, 'case.json'); result.caseHash = hash(rawCase);
    const parsed = caseV2Schema.safeParse(rawCase);
    const staticCheck = validate(rawCase);
    result.issues = [...staticCheck.issues, ...(parsed.success ? designConsistency(d.design, parsed.data) : [])];
    if (result.issues.some(x => x.severity !== 'warning') || !parsed.success) return result;
    if (mode === 'quick') { result.ok = true; return result; }
    result.key = await validationKey(result.designHash, result.caseHash, searchStateLimit);
    let checked: ReturnType<typeof audit>;
    let cached: CachedAudit | undefined;
    try { cached = await readJson(cacheFile(root, result.key)) as CachedAudit; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (cached?.key === result.key && hash(cached.audit) === cached.auditHash) {
      checked = cached.audit; result.cacheHit = true;
    } else {
      const startSearch = Date.now(); checked = audit(rawCase, searchStateLimit);
      result.searchCount = 1; result.searchMs = Date.now() - startSearch;
      await saveJson(cacheFile(root, result.key), { key: result.key, audit: checked, auditHash: hash(checked) });
    }
    result.auditHash = hash(checked); result.issues = [...result.issues, ...checked.issues];
    result.ok = checked.ok; result.states = checked.search?.states;
    if (mode === 'replay' && checked.search?.replay) result.replay = { opening: checked.search.replay.opening,
      ended: checked.search.replay.ended, steps: checked.search.replay.steps.map(({ command, text, playerBefore }) => ({ command, text,
        ...(['reason', 'present'].includes(command.kind) ? { playerBefore } : {}) })) };
    return result;
  } catch (e) {
    result.failureKind ??= e instanceof SyntaxError || (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'content' : 'tool-execution';
    result.issues.push({ code: 'artifact', path: mode, message: String(e) }); return result;
  } finally {
    result.elapsedMs = Date.now() - started;
    if (!result.ok) result.failureKind ??= 'content';
    await recordToolCall(root, result, rawDesign, rawCase);
  }
}

export async function toolHistory(workspace: string): Promise<ToolReport[]> {
  try { return (await readFile(join(workspace, '.detective-tools', 'calls.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(x => JSON.parse(x)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, mode, limitValue] = process.argv.slice(2);
  if (!workspace || !['design', 'quick', 'case', 'replay', 'foundation-review'].includes(mode ?? '')) throw new Error('author-tools 内容目录 design|quick|case|replay|foundation-review [搜索上限]');
  const limit = limitValue === undefined ? defaultDetectiveConfig.validation.searchStateLimit : Number(limitValue);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('searchStateLimit must be a positive integer');
  const history = await toolHistory(workspace);
  const maximum = mode === 'quick' ? 24 : mode === 'design' ? 12 : mode === 'foundation-review' ? 16 : 12;
  if (history.filter(x => x.mode === mode).length >= maximum) {
    const result: ToolReport = { tool: toolMarker, mode: mode as ToolMode, workspace: await realpath(workspace), ok: false,
      designHash: null, caseHash: null, failureKind: 'tool-execution', elapsedMs: 0, searchCount: 0,
      issues: [{ code: 'tool-budget', path: mode!, message: `工具预算上限 ${maximum} 次；提交当前候选由程序验收` }] };
    await recordToolCall(result.workspace, result);
    console.log(JSON.stringify(result)); process.exitCode = 2;
  } else { const report = await checkAuthorWorkspace(workspace, mode as ToolMode, limit); console.log(JSON.stringify(report)); if (!report.ok) process.exitCode = 1; }
}
