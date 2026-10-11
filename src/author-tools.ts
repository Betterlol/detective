import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDesign, designConsistency } from './design-validation.js';
import { audit } from './validate.js';
import { caseV2Schema } from './model.js';
import { hash, readJson } from './io.js';
import type { Issue } from './validation-types.js';
import { defaultDetectiveConfig } from './config.js';

export const toolMarker = 'detective-validator-1.0';
export type ToolMode = 'design' | 'case' | 'replay';
export type ToolReport = { tool: string; mode: ToolMode; workspace: string; ok: boolean; issues: Issue[];
  designHash: string | null; caseHash: string | null; states?: number;
  replay?: { opening: string[]; ended: boolean; steps: { command: unknown; text: string[] }[] } | null };

export async function readAuthorArtifact(workspace: string, name: 'design.json' | 'case.json') {
  const file = join(workspace, name), stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('作者产物必须是内容目录内的普通 JSON 文件');
  const root = await realpath(workspace), target = await realpath(file);
  if (resolve(target).toLowerCase() !== resolve(join(root, name)).toLowerCase()) throw new Error('作者产物超出内容目录');
  return readJson(file);
}

export async function checkAuthorWorkspace(workspace: string, mode: ToolMode,
  searchStateLimit = defaultDetectiveConfig.validation.searchStateLimit): Promise<ToolReport> {
  const root = await realpath(workspace);
  const result: ToolReport = { tool: toolMarker, mode, workspace: root, ok: false, issues: [], designHash: null, caseHash: null };
  try {
    const rawDesign = await readAuthorArtifact(root, 'design.json'); result.designHash = hash(rawDesign);
    const d = auditDesign(rawDesign); result.issues = d.issues;
    if (!d.ok || !d.design) return result;
    if (mode === 'design') { result.ok = true; return result; }
    const rawCase = await readAuthorArtifact(root, 'case.json'); result.caseHash = hash(rawCase);
    const parsed = caseV2Schema.safeParse(rawCase), a = audit(rawCase, searchStateLimit);
    result.issues = [...a.issues, ...(parsed.success ? designConsistency(d.design, parsed.data) : [])];
    result.ok = a.ok && parsed.success && !result.issues.some(x => x.severity !== 'warning');
    result.states = a.search?.states;
    if (mode === 'replay' && a.search?.replay) result.replay = { opening: a.search.replay.opening,
      ended: a.search.replay.ended, steps: a.search.replay.steps.map(({ command, text }) => ({ command, text })) };
    return result;
  } catch (e) {
    result.issues.push({ code: 'artifact', path: mode, message: String(e) }); return result;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, mode, limitValue] = process.argv.slice(2);
  if (!workspace || !['design', 'case', 'replay'].includes(mode ?? '')) throw new Error('author-tools 内容目录 design|case|replay');
  const limit = limitValue === undefined ? defaultDetectiveConfig.validation.searchStateLimit : Number(limitValue);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('searchStateLimit must be a positive integer');
  const report = await checkAuthorWorkspace(workspace, mode as ToolMode, limit);
  console.log(JSON.stringify(report)); if (!report.ok) process.exitCode = 1;
}
