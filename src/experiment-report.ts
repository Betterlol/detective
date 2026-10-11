import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, readJson, saveJson } from './io.js';
import { caseSchema } from './model.js';

export function changes(before: unknown, after: unknown, path = '$'): { path: string; before: unknown; after: unknown }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => changes(a[k], b[k], path + '.' + k));
  }
  return [{ path, before: before ?? null, after: after ?? null }];
}
export async function experimentReport(root: string) {
  const calls: { directory: string; completed: boolean; elapsedMs: number | null; usage: unknown; model: string; promptHash: string; itemTypes: string[] }[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some(x => x.name === 'request.json')) {
      const request = await readJson(join(dir, 'request.json')) as { model: string; promptHash?: string };
      type Transport = { elapsedMs?: number; exitCode?: number; status?: number };
      let transport: Transport | null = null, usage: unknown = null; const itemTypes = new Set<string>();
      try { transport = await readJson(join(dir, 'transport.json')) as Transport; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      try {
        const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n');
        const events = lines.map(x => JSON.parse(x));
        usage = events.find(x => x.type === 'turn.completed')?.usage ?? null;
        events.forEach(x => { if (x.item?.type) itemTypes.add(x.item.type); });
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const promptHash = request.promptHash || hash(await readFile(join(dir, 'prompt.md'), 'utf8'));
      calls.push({ directory: dir, model: request.model, promptHash, completed: transport?.exitCode === 0 || transport?.status === 200,
        elapsedMs: transport?.elapsedMs ?? null, usage, itemTypes: [...itemTypes] });
    }
    for (const entry of entries) if (entry.isDirectory()) await walk(join(dir, entry.name));
  }
  await walk(root);
  const experiments = [], options = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let manifest: { status: string; attempts: { index: number; kind: string; status: string; diagnostics: unknown }[] };
    try { manifest = await readJson(join(dir, 'manifest.json')) as typeof manifest; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    const repairs = [];
    for (const attempt of manifest.attempts.filter(x => x.kind === 'repair')) {
      const beforePath = attempt.index ? join(dir, `attempt-${attempt.index - 1}`, 'case.json') : join(dir, 'source.json');
      try {
        const before = await readJson(beforePath), after = await readJson(join(dir, `attempt-${attempt.index}`, 'case.json'));
        const delta = { beforeHash: hash(before), afterHash: hash(after), changes: changes(before, after) };
        await saveJson(join(dir, `attempt-${attempt.index}`, 'repair-diff.json'), delta);
        repairs.push({ attempt: attempt.index, fieldsChanged: delta.changes.length });
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    const resumes = [];
    for (const filename of (await readdir(dir)).filter(x => /^resume-\d.*\.json$/.test(x))) {
      const record = await readJson(join(dir, filename)) as { at: string; priorManifest: { status: string }; feedback: unknown };
      resumes.push({ snapshot: filename, at: record.at, priorStatus: record.priorManifest.status, feedback: record.feedback });
    }
    experiments.push({ directory: entry.name, status: manifest.status, attempts: manifest.attempts, repairs, resumes });
    if (manifest.status === 'accepted') {
      const c = caseSchema.parse(await readJson(join(dir, 'case.json')));
      for (const i of c.inferences) {
        const lengths = i.options.map(o => [...o.text.replace(/\s/g, '')].length), longest = Math.max(...lengths);
        options.push({ directory: entry.name, inferenceId: i.id, lengths,
          longestCount: lengths.filter(x => x === longest).length,
          longestIncludesAnswer: i.options.some((o, n) => lengths[n] === longest && i.solutions.some(s => s.optionId === o.id)) });
      }
    }
  }
  const result = { generatedAt: new Date().toISOString(), calls, callCount: calls.length,
    completedCalls: calls.filter(x => x.completed).length,
    phases: { design: calls.filter(x => /[\\/]design$/.test(x.directory)).length,
      content: calls.filter(x => /[\\/]attempt-\d+$/.test(x.directory)).length,
      review: calls.filter(x => /[\\/]review$/.test(x.directory)).length,
      player: calls.filter(x => /[\\/]decision-\d+$/.test(x.directory)).length },
    experiments, options,
    limits: '调用耗时之和不等于并行运行的总用时；最长选项基线仅检测篇幅线索，不证明没有语义提示；差异由原模型案件计算，未修改故事。' };
  await saveJson(join(root, 'experiment-report.json'), result); return result;
}
