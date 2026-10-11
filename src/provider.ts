import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { saveJson, saveText } from './io.js';

export type ModelConfig = { provider: 'codex' | 'responses'; model: string; timeoutMs: number };
export function modelConfig(): ModelConfig {
  return { provider: process.env.DETECTIVE_PROVIDER === 'responses' ? 'responses' : 'codex',
    model: process.env.DETECTIVE_MODEL || 'gpt-6.1-sol', timeoutMs: Number(process.env.DETECTIVE_TIMEOUT_MS || 480_000) };
}
async function codexCommand(): Promise<{ executable: string; prefix: string[] }> {
  const explicit = process.env.DETECTIVE_CODEX_PATH || process.env.CODEX_CLI_PATH;
  if (explicit) {
    if (/\.js$/i.test(explicit)) return { executable: process.execPath, prefix: [explicit] };
    if (/\.(ps1|cmd|bat)$/i.test(explicit)) throw new Error('DETECTIVE_CODEX_PATH 请指定 codex.exe 或内部 node_modules/@openai/codex/bin/codex.js');
    return { executable: explicit, prefix: [] };
  }
  if (process.platform === 'win32') for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const candidate of [join(dir, 'codex.exe'), join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]) {
      try { await access(candidate); return /\.js$/i.test(candidate) ? { executable: process.execPath, prefix: [candidate] } : { executable: candidate, prefix: [] }; }
      catch { /* Try the next executable/shim installation. */ }
    }
  }
  return { executable: 'codex', prefix: [] };
}
export async function callModel(prompt: string, schema: unknown, dir: string, config = modelConfig()): Promise<string> {
  await saveText(join(dir, 'prompt.md'), prompt);
  await saveJson(join(dir, 'schema.json'), schema);
  await saveJson(join(dir, 'request.json'), { ...config, startedAt: new Date().toISOString(), toolUse: false });
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
  // An isolated cwd avoids feeding any previous case or project instruction into the creator/reviewer.
  const cli = await codexCommand();
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '--model', config.model, '--json', '--color', 'never', '--output-schema', resolve(dir, 'schema.json'),
    '--output-last-message', resolve(dir, 'raw.json'), '-'];
  const start = Date.now();
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
      const env = { ...process.env };
      delete env.OPENAI_API_KEY; delete env.OPENAI_BASE_URL; delete env.OPENAI_API_URL;
      delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
      const child = spawn(cli.executable, [...cli.prefix, ...args], { cwd: temp, env, windowsHide: true, shell: false });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('模型调用超时')); }, config.timeoutMs);
      child.stdout.on('data', x => { stdout += String(x); });
      child.stderr.on('data', x => { stderr += String(x); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
      child.stdin.end(prompt);
    });
    await saveText(join(dir, 'events.jsonl'), result.stdout);
    await saveText(join(dir, 'stderr.txt'), result.stderr);
    await saveJson(join(dir, 'transport.json'), { exitCode: result.code, elapsedMs: Date.now() - start, model: config.model, args: args.map(x => x === temp ? '<isolated-cwd>' : x) });
    if (result.code !== 0) throw new Error(`Codex 模型调用失败，退出码 ${result.code}，详见 ${join(dir, 'stderr.txt')}`);
    return await readFile(join(dir, 'raw.json'), 'utf8');
  } finally {
    // The exact mkdtemp child is the only removed directory; never enumerate and delete arbitrary paths.
    if (temp.startsWith(join(tmpdir(), 'detective-model-'))) await rm(temp, { recursive: true, force: true });
  }
}
