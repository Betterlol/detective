import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ThreadEvent } from '@openai/codex-sdk';
import { designSchema } from './design.js';
import { auditDesign, designConsistency } from './design-validation.js';
import { designReviewAccepted, designReviewSchema } from './design-review.js';
import { caseV2Schema, type CaseV2 } from './model.js';
import { trustedValidation, type AuthorState } from './author-session.js';
import { hash, readJson } from './io.js';
import type { SdkManifest } from './sdk-generation.js';
import { defaultDetectiveConfig } from './config.js';
import { isReconnectNotice } from './sdk-run.js';

export function experimentPath(root: string, path: string) {
  const target = resolve(root, path), rel = relative(resolve(root), target);
  if (!path || isAbsolute(path) || !rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel))
    throw new Error('来源路径必须在实验目录内');
  return target;
}
async function eventsAt(dir: string): Promise<ThreadEvent[]> {
  return (await readFile(join(dir, 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(x => JSON.parse(x));
}
async function authorRunValid(dir: string, threadId: string, workspace: string, mode: 'design' | 'case', artifactHash: string,
  searchStateLimit: number, designHash?: string) {
  const transport = await readJson(join(dir, 'transport.json')) as { threadId: string; exitCode: number };
  const request = await readJson(join(dir, 'request.json')) as { engine: string; toolUse: boolean; promptHash: string };
  const prompt = await readFile(join(dir, 'prompt.md'), 'utf8'), events = await eventsAt(dir);
  const items = events.filter((x): x is Extract<ThreadEvent, { type: 'item.completed' }> => x.type === 'item.completed').map(x => x.item);
  const evidence = trustedValidation(items, workspace, mode, artifactHash, searchStateLimit) ??
    (mode === 'case' ? trustedValidation(items, workspace, 'replay', artifactHash, searchStateLimit) : null);
  const stored = await readJson(join(dir, 'validation-evidence.json'));
  let boundary = false;
  if (!evidence && mode === 'case') {
    const checked = await readJson(join(dir, 'boundary-validation.json')) as {
      caseHash: string; designHash: string; searchStateLimit: number; ok: boolean; auditHash: string;
    };
    const audit = await readJson(join(dir, '..', 'audit.json')) as { ok: boolean; search?: { exhaustive?: boolean } };
    boundary = checked.caseHash === artifactHash && checked.designHash === designHash &&
      checked.searchStateLimit === searchStateLimit && checked.ok && checked.auditHash === hash(audit) &&
      audit.ok && audit.search?.exhaustive === true;
  } else if (!evidence && mode === 'design') {
    const checked = await readJson(join(dir, 'audit.json')) as { ok: boolean };
    boundary = checked.ok;
  }
  const raw = await readFile(join(dir, 'raw.json'), 'utf8');
  return transport.exitCode === 0 && transport.threadId === threadId && request.engine === 'codex-sdk' && request.toolUse &&
    request.promptHash === hash(prompt) && events.some(x => x.type === 'thread.started' && x.thread_id === threadId) &&
    events.some(x => x.type === 'turn.completed') && items.filter(x => x.type === 'agent_message').at(-1)?.text === raw &&
    (evidence ? hash(evidence) === hash(stored) : boundary);
}
export async function isolatedSdkRunValid(dir: string, authorId: string) {
  const transport = await readJson(join(dir, 'transport.json')) as { threadId: string; exitCode: number };
  const request = await readJson(join(dir, 'request.json')) as { engine: string; toolUse: boolean; promptHash: string };
  const events = await eventsAt(dir), prompt = await readFile(join(dir, 'prompt.md'), 'utf8'), raw = await readFile(join(dir, 'raw.json'), 'utf8');
  const messages = events.flatMap(x => x.type === 'item.completed' && x.item.type === 'agent_message' ? [x.item.text] : []);
  const toolTypes = ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'];
  return transport.exitCode === 0 && !!transport.threadId && transport.threadId !== authorId && request.engine === 'codex-sdk' &&
    request.toolUse === false && request.promptHash === hash(prompt) && messages.at(-1) === raw && events.some(x => x.type === 'turn.completed') &&
    !events.some(x => (x.type === 'error' && !isReconnectNotice(x.message)) || x.type === 'turn.failed') &&
    events.some(x => x.type === 'thread.started' && x.thread_id === transport.threadId) &&
    !events.some(x => 'item' in x && toolTypes.includes(x.item.type));
}

export async function verifySdkProvenance(dir: string, manifest: SdkManifest, c: CaseV2) {
  const problems: string[] = [];
  const searchStateLimit = manifest.settings?.validation.searchStateLimit ?? defaultDetectiveConfig.validation.searchStateLimit;
  try {
    const attempt = manifest.attempts.find(x => x.index === manifest.acceptedAttempt), source = attempt?.source;
    if (!source || source.kind !== 'sdk-file' || source.threadId !== manifest.authorThreadId ||
      source.designHash !== manifest.acceptedDesignHash || source.foundationIndex !== manifest.acceptedFoundation) throw new Error('SDK 作者来源与已验收设计未绑定');
    const state = await readJson(join(dir, 'author-session.json')) as AuthorState;
    if (state.version !== 'sdk-author-1.0' || state.threadId !== source.threadId ||
      state.stages.some(x => x.threadId && x.threadId !== source.threadId)) throw new Error('作者跨阶段会话不连续');
    const stage = state.stages.find(x => x.directory.replace(/\\/g, '/') === source.stageDirectory && x.status === 'completed');
    if (!stage) throw new Error('缺少完成的作者阶段记录');
    const stageDir = experimentPath(dir, source.stageDirectory);
    let artifact = await readJson(join(stageDir, 'artifact.json'));
    if (stage.artifactHash !== source.artifactHash) artifact = await readJson(join(stageDir, 'case-artifact.json'));
    if (hash(artifact) !== source.artifactHash || hash(caseV2Schema.parse(artifact)) !== hash(c)) throw new Error('最终案件与作者文件快照不一致');
    if (!await authorRunValid(stageDir, source.threadId, state.workspace, 'case', source.artifactHash, searchStateLimit, source.designHash)) throw new Error('作者案件校验工具来源不成立');
    const foundation = manifest.foundationAttempts.find(x => x.index === source.foundationIndex);
    if (!foundation || foundation.status !== 'accepted' || !foundation.sourceHash || foundation.threadId !== source.threadId) throw new Error('缺少验收通过的基石阶段');
    const foundationDir = experimentPath(dir, foundation.sourceDirectory), originalDesign = await readJson(join(foundationDir, 'artifact.json'));
    const d = designSchema.parse(await readJson(join(dir, 'design/design.json')));
    if (!auditDesign(d).ok || hash(d) !== source.designHash || foundation.designHash !== hash(d) ||
      hash(originalDesign) !== foundation.sourceHash || hash(designSchema.parse(originalDesign)) !== hash(d) || designConsistency(d, c).length)
      throw new Error('基石快照或成品事实一致性不成立');
    if (!await authorRunValid(foundationDir, source.threadId, state.workspace, 'design', foundation.sourceHash, searchStateLimit)) throw new Error('作者基石校验工具来源不成立');
    const reviewDir = experimentPath(dir, foundation.reviewDirectory);
    const foundationReviewEnabled = foundation.reviewSkipped === undefined ? (manifest.settings?.workflow.foundationReview ?? true) : !foundation.reviewSkipped;
    if (foundationReviewEnabled) {
      const review = designReviewSchema.parse(await readJson(join(reviewDir, 'review.json')));
      const originalReview = designReviewSchema.parse(JSON.parse(await readFile(join(reviewDir, 'raw.json'), 'utf8')));
      if (hash(review) !== hash(originalReview) || !designReviewAccepted(d, review) || !await isolatedSdkRunValid(reviewDir, source.threadId))
        throw new Error('基石独立逻辑评审来源不成立');
    } else {
      const skipped = await readJson(join(reviewDir, 'skipped.json')) as { mechanism?: string };
      if (skipped.mechanism !== 'foundationReview') throw new Error('基石评审关闭状态缺失');
    }
    const acceptedAttemptDir = join(dir, `attempt-${manifest.acceptedAttempt}`);
    if (manifest.settings?.workflow.caseReview ?? true) {
      if (!await isolatedSdkRunValid(join(acceptedAttemptDir, 'review'), source.threadId)) throw new Error('案件评审没有保持隔离');
    } else {
      const skipped = await readJson(join(acceptedAttemptDir, 'review', 'skipped.json')) as { mechanism?: string };
      if (skipped.mechanism !== 'caseReview') throw new Error('案件评审关闭状态缺失');
    }
  } catch (e) { problems.push(String(e)); }
  return { ok: problems.length === 0, problems };
}
