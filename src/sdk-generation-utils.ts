import { readJson } from './io.js';

export function budget(value: number, maximum: number) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new Error(`修复预算必须为0至${maximum}`);
  return value;
}

export async function optionalJson(path: string) {
  try { return await readJson(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return undefined;
  }
}

export function usedBudget(records: { status: string; consumesBudget?: boolean }[]) {
  return records.filter(x => x.consumesBudget ?? ![
    'running', 'interrupted', 'author-failed', 'author-or-evaluation-failed', 'design-revision-requested', 'design-revision-failed',
  ].includes(x.status)).length;
}
