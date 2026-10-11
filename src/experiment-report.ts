import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, readJson, saveJson } from './io.js';
import { caseSchema } from './model.js';
import { toolHistory } from './author-tools.js';

export function changes(before: unknown, after: unknown, path = '$'): { path: string; before: unknown; after: unknown }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => changes(a[k], b[k], path + '.' + k));
  }
  return [{ path, before: before ?? null, after: after ?? null }];
}
export async function experimentReport(root: string) {
  const calls: { directory: string; completed: boolean; elapsedMs: number | null; usage: unknown; model: string; promptHash: string; itemTypes: string[];
    executionFailures: { command: string; exitCode: number; failureKind: string; outputTail: string }[]; reconnectNotices: string[] }[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some(x => x.name === 'request.json')) {
      const request = await readJson(join(dir, 'request.json')) as { model: string; promptHash?: string };
      type Transport = { elapsedMs?: number; exitCode?: number; status?: number; usage?: unknown; reconnectNotices?: string[] };
      let transport: Transport | null = null, usage: unknown = null; const itemTypes = new Set<string>();
      const executionFailures: (typeof calls)[number]['executionFailures'] = [], reconnectNotices: string[] = [];
      try { transport = await readJson(join(dir, 'transport.json')) as Transport; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      try {
        const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean);
        const events = lines.map(x => JSON.parse(x));
        usage = events.find(x => x.type === 'turn.completed')?.usage ?? null;
        events.forEach(x => { if (x.item?.type) itemTypes.add(x.item.type); });
        for (const event of events) {
          if (event.type === 'error' && /^Reconnecting/.test(event.message)) reconnectNotices.push(event.message);
          const item = event.item;
          if (event.type !== 'item.completed' || item?.type !== 'command_execution' || !item.exit_code) continue;
          let failureKind = 'tool-execution';
          for (const line of item.aggregated_output.split(/\r?\n/)) {
            try { const report = JSON.parse(line); if (report.tool?.startsWith('detective-validator')) failureKind = report.failureKind ?? 'content'; } catch { /* Shell output is not necessarily JSON. */ }
          }
          executionFailures.push({ command: item.command, exitCode: item.exit_code, failureKind,
            outputTail: item.aggregated_output.slice(-2000) });
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      usage ??= transport?.usage ?? null;
      const promptHash = request.promptHash || hash(await readFile(join(dir, 'prompt.md'), 'utf8'));
      calls.push({ directory: dir, model: request.model, promptHash, completed: transport?.exitCode === 0 || transport?.status === 200,
        elapsedMs: transport?.elapsedMs ?? null, usage, itemTypes: [...itemTypes], executionFailures, reconnectNotices });
    }
    for (const entry of entries) if (entry.isDirectory()) await walk(join(dir, entry.name));
  }
  await walk(root);
  const experiments = [], options = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let manifest: { status: string; startedAt?: string; completedAt?: string; foundationAttempts?: unknown[];
      acceptedAttempt?: number; attempts: { index: number; kind: string; status: string; diagnostics: unknown }[] };
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
    const tools = await toolHistory(join(dir, 'author'));
    const localCalls = calls.filter(x => x.directory.startsWith(dir + (process.platform === 'win32' ? '\\' : '/')));
    const tokenTotals: Record<string, number> = {};
    for (const call of localCalls) if (call.usage && typeof call.usage === 'object') {
      for (const [key, value] of Object.entries(call.usage)) if (typeof value === 'number') tokenTotals[key] = (tokenTotals[key] ?? 0) + value;
    }
    const boundaries = [];
    for (const call of localCalls.filter(x => /[\\/](?:build|repair|polish)$/.test(x.directory))) {
      try { boundaries.push(await readJson(join(call.directory, 'boundary-validation.json')) as { searchCount: number; reused: boolean; elapsedMs: number }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    const firstCheck = tools.find(x => ['quick', 'case'].includes(x.mode));
    const firstFull = tools.find(x => x.mode === 'case');
    type AuditMetric = { elapsedMs: number; searchCount: number };
    let offlineVerification: AuditMetric | null = null;
    let mutationAudits: AuditMetric[] = [];
    try {
      const v = await readJson(join(dir, 'verification.json')) as { auditMetrics: AuditMetric };
      offlineVerification = v.auditMetrics;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    try {
      const m = await readJson(join(root, 'regression', entry.name, 'mutations.json')) as { results: { auditMetrics: typeof mutationAudits[number] }[] };
      mutationAudits = m.results.map(x => x.auditMetrics).filter(Boolean);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    experiments.push({ directory: entry.name, status: manifest.status, attempts: manifest.attempts,
      foundationAttempts: manifest.foundationAttempts ?? [], repairs, resumes,
      firstContentCheckPassed: firstCheck?.ok ?? null, firstFullCheckPassed: firstFull?.ok ?? (boundaries[0] as { ok?: boolean } | undefined)?.ok ?? null,
      firstSubmissionPassed: ['accepted', 'additional-review-failed'].includes(manifest.attempts[0]?.status ?? ''),
      metrics: { wallMs: manifest.startedAt && manifest.completedAt ? Date.parse(manifest.completedAt) - Date.parse(manifest.startedAt) : null,
        sdkTurns: localCalls.length, authorTurns: localCalls.filter(x => !/[\\/]reviews?[\\/]/.test(x.directory) && !/[\\/]review$/.test(x.directory) && !/[\\/]decision-\d+$/.test(x.directory)).length,
        tokenTotals, usageMissingCalls: localCalls.filter(x => !x.usage).length,
        executionFailures: localCalls.flatMap(x => x.executionFailures), reconnectNotices: localCalls.flatMap(x => x.reconnectNotices),
        toolCalls: tools.length, counts: Object.fromEntries(['design', 'quick', 'case', 'replay', 'foundation-review'].map(mode => [mode, tools.filter(x => x.mode === mode).length])),
        searches: tools.reduce((n, x) => n + (x.searchCount ?? 0), 0) + boundaries.reduce((n, x) => n + x.searchCount, 0),
        searchMs: tools.reduce((n, x) => n + (x.searchMs ?? 0), 0), toolMs: tools.reduce((n, x) => n + (x.elapsedMs ?? 0), 0),
        cacheHits: tools.filter(x => x.cacheHit).length, boundaryCacheHits: boundaries.filter(x => x.reused).length, boundaries,
        offlineVerification, mutationAudits,
        verificationSearches: (offlineVerification?.searchCount ?? 0) + mutationAudits.reduce((n, x) => n + x.searchCount, 0),
        verificationMs: (offlineVerification?.elapsedMs ?? 0) + mutationAudits.reduce((n, x) => n + x.elapsedMs, 0) },
      toolFailures: tools.filter(x => !x.ok), tools });
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
    phases: { design: calls.filter(x => /[\\/]design(?:[\\/]attempt-\d+)?$/.test(x.directory)).length,
      content: calls.filter(x => !/[\\/]design[\\/]attempt-\d+$/.test(x.directory) && /[\\/]attempt-\d+(?:[\\/](?:build|polish|repair))?$/.test(x.directory)).length,
      review: calls.filter(x => /[\\/]review$/.test(x.directory) || /[\\/]reviews[\\/]/.test(x.directory)).length,
      player: calls.filter(x => /[\\/]decision-\d+$/.test(x.directory)).length },
    experiments, options,
    rates: { sampleCount: experiments.length, firstContentCheck: experiments.filter(x => x.firstContentCheckPassed).length,
      firstFullCheck: experiments.filter(x => x.firstFullCheckPassed).length,
      firstSubmission: experiments.filter(x => x.firstSubmissionPassed).length, finalAccepted: experiments.filter(x => x.status === 'accepted').length },
    limits: 'sdkTurns 是可观测 SDK 轮次/隔离评审调用数，CLI 内部实际模型请求数未暴露；token/cache 来自 SDK usage。作者工具耗时包含嵌套设计评审，因此不能与模型耗时重复相加；boundary耗时可能包含新搜索。调用耗时之和不等于并行总用时。首次内容检查、首次完整检查和首次提交分别记录，内部失败未排除。最长选项只能检测篇幅提示。' };
  await saveJson(join(root, 'experiment-report.json'), result); return result;
}
