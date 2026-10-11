import { Codex, type ThreadOptions, type ThreadEvent, type ThreadItem, type TurnOptions, type Usage } from '@openai/codex-sdk';
import { appendFile, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { hash, saveJson, saveText } from './io.js';
import type { ModelConfig } from './provider.js';
import { fixedModelConfig } from './model-policy.js';

export interface AgentThread {
  readonly id: string | null;
  runStreamed(input: string, options?: TurnOptions): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}
export interface AgentClient {
  startThread(options: ThreadOptions): AgentThread;
  resumeThread(id: string, options: ThreadOptions): AgentThread;
}
export type LoggedRun = { finalResponse: string; threadId: string; items: ThreadItem[]; usage: Usage | null };
export class ModelCallError extends Error {}
export function isReconnectNotice(message: string) {
  const match = /^Reconnecting\.\.\. (\d+)\/(\d+) \(/.exec(message);
  return !!match && Number(match[1]) <= Number(match[2]) && Number(match[2]) <= 5;
}

export function createCodexClient(): AgentClient {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_URL', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE']) delete env[key];
  let binary = process.env.DETECTIVE_CODEX_PATH || process.env.CODEX_CLI_PATH;
  if (binary && /\.(ps1|cmd|bat)$/i.test(binary)) throw new Error('SDK 需要 Codex 原生可执行文件，不接受 shell shim');
  if (binary && /\.js$/i.test(binary)) {
    const platforms: Record<string, string> = { win32: 'pc-windows-msvc', linux: 'unknown-linux-musl', darwin: 'apple-darwin' };
    const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64';
    const triple = `${arch}-${platforms[process.platform]}`;
    const require = createRequire(resolve(binary));
    const roots = [join(dirname(binary), '..', 'vendor')];
    try { roots.unshift(join(dirname(require.resolve(`@openai/codex-${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}/package.json`)), 'vendor')); } catch { /* Older CLI bundles its vendor directory. */ }
    const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
    binary = roots.flatMap(root => [join(root, triple, 'bin', name), join(root, triple, 'codex', name)]).find(existsSync);
    if (!binary) throw new Error('无法从指定的 Codex JavaScript 入口定位原生程序；请指定可执行文件');
  }
  return new Codex({ env, codexPathOverride: binary, configOverrides: ['mcp_servers={}'] });
}

export function agentOptions(config: ModelConfig, workingDirectory: string, author: boolean): ThreadOptions {
  config = fixedModelConfig(config);
  return { model: config.model, workingDirectory: resolve(workingDirectory), skipGitRepoCheck: true,
    sandboxMode: author ? 'workspace-write' : 'read-only', approvalPolicy: 'never',
    networkAccessEnabled: false, webSearchMode: 'disabled', modelReasoningEffort: config.reasoningEffort };
}

export async function removeTempDirectory(dir: string, expectedParent: string, prefix: string) {
  const target = await realpath(dir), parent = await realpath(expectedParent);
  if (dirname(target).toLowerCase() !== parent.toLowerCase() || !basename(target).startsWith(prefix)) throw new Error('拒绝删除不匹配的临时目录');
  await rm(target, { recursive: true, force: true });
}

export async function runLoggedThread(thread: AgentThread, prompt: string, schema: unknown, dir: string,
  config: ModelConfig, allowTools: boolean, onThread?: (id: string) => void | Promise<void>): Promise<LoggedRun> {
  config = fixedModelConfig(config);
  await saveText(join(dir, 'prompt.md'), prompt);
  await saveJson(join(dir, 'schema.json'), schema);
  await saveJson(join(dir, 'request.json'), { ...config, engine: 'codex-sdk', promptHash: hash(prompt),
    startedAt: new Date().toISOString(), toolUse: allowTools, threadId: thread.id });
  await saveText(join(dir, 'events.jsonl'), '');
  const start = Date.now(); let finalResponse = '', threadId = thread.id, usage: Usage | null = null, completed = false;
  const items: ThreadItem[] = [];
  const reconnectNotices: string[] = [];
  try {
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) throw new Error('模型超时必须是正数');
    const run = await thread.runStreamed(prompt, { outputSchema: schema, signal: AbortSignal.timeout(config.timeoutMs) });
    for await (const event of run.events) {
      await appendFile(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8');
      if (event.type === 'thread.started') {
        if (threadId && threadId !== event.thread_id) throw new Error('作者会话 ID 意外变化');
        threadId = event.thread_id; await onThread?.(threadId);
      }
      if (event.type === 'error' && isReconnectNotice(event.message)) { reconnectNotices.push(event.message); continue; }
      if (event.type === 'turn.failed' || event.type === 'error') throw new Error(event.type === 'error' ? event.message : event.error.message);
      if ('item' in event) {
        if (!allowTools && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(event.item.type))
          throw new Error('隔离评审或玩家调用了禁止的工具，拒绝该结果');
        if (event.type === 'item.completed') {
          items.push(event.item);
          if (event.item.type === 'agent_message') finalResponse = event.item.text;
        }
      }
      if (event.type === 'turn.completed') { usage = event.usage; completed = true; }
    }
    if (!completed || !threadId || !finalResponse) throw new Error('SDK 未完成该轮或没有返回最终回复');
    await saveText(join(dir, 'raw.json'), finalResponse);
    await saveJson(join(dir, 'transport.json'), { exitCode: 0, elapsedMs: Date.now() - start, model: config.model, threadId, usage, reconnectNotices });
    return { finalResponse, threadId, items, usage };
  } catch (e) {
    if (finalResponse) await saveText(join(dir, 'raw.json'), finalResponse);
    await saveJson(join(dir, 'transport.json'), { exitCode: 1, elapsedMs: Date.now() - start, model: config.model, threadId, usage, reconnectNotices, error: String(e) });
    throw new ModelCallError(String(e));
  }
}
