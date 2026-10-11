import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, saveJson, saveText } from './io.js';
import { agentOptions, createCodexClient, removeTempDirectory, runLoggedThread } from './sdk-run.js';

export type ModelConfig = { provider: 'codex' | 'responses'; model: string; timeoutMs: number };
export function modelConfig(): ModelConfig {
  return { provider: process.env.DETECTIVE_PROVIDER === 'responses' ? 'responses' : 'codex',
    model: process.env.DETECTIVE_MODEL || 'gpt-6-luna', timeoutMs: Number(process.env.DETECTIVE_TIMEOUT_MS || 480_000) };
}
export async function callModel(prompt: string, schema: unknown, dir: string, config = modelConfig()): Promise<string> {
  await saveText(join(dir, 'prompt.md'), prompt);
  await saveJson(join(dir, 'schema.json'), schema);
  await saveJson(join(dir, 'request.json'), { ...config, promptHash: hash(prompt), startedAt: new Date().toISOString(), toolUse: false });
  if (config.provider === 'responses') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('responses 接入需要 OPENAI_API_KEY');
    const base = (process.env.OPENAI_BASE_URL || process.env.OPENAI_API_URL || 'https://api.openai.com/v1').replace(/\/$/, '').replace(/\/responses$/, '');
    const start = Date.now();
    const response = await fetch(base + '/responses', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, input: prompt, store: false, text: { format: { type: 'json_schema', name: 'artifact', strict: true, schema } } }),
      signal: AbortSignal.timeout(config.timeoutMs) });
    if (!response.ok) { await saveJson(join(dir, 'transport.json'), { status: response.status, elapsedMs: Date.now() - start }); throw new Error(`模型请求 HTTP ${response.status}`); }
    const body = await response.json() as { id: string; model: string; usage: unknown; output: { type: string; content?: { type: string; text?: string }[] }[] };
    await saveJson(join(dir, 'response.json'), body);
    await saveJson(join(dir, 'transport.json'), { status: response.status, model: body.model, responseId: body.id, usage: body.usage, elapsedMs: Date.now() - start });
    const raw = body.output.flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text || '').join('');
    await saveText(join(dir, 'raw.json'), raw); return raw;
  }
  const temp = await mkdtemp(join(tmpdir(), 'detective-model-'));
  try {
    const thread = createCodexClient().startThread(agentOptions(config, temp, false));
    return (await runLoggedThread(thread, prompt, schema, dir, config, false)).finalResponse;
  } finally {
    await removeTempDirectory(temp, tmpdir(), 'detective-model-');
  }
}
