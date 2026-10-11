import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson } from './io.js';

export async function repairSource(dir: string, attempts: { index: number }[]): Promise<unknown> {
  for (const attempt of [...attempts].sort((a, b) => b.index - a.index)) {
    try { return await readJson(join(dir, `attempt-${attempt.index}`, 'case.json')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    try {
      const raw = await readFile(join(dir, `attempt-${attempt.index}`, 'raw.json'), 'utf8');
      if (raw.trim()) { try { return JSON.parse(raw); } catch { return raw; } }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  try { return await readJson(join(dir, 'source.json')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return undefined;
}
export async function archivePlayerBinding(dir: string, attempt: number) {
  const destination = join(dir, `player-verification-before-attempt-${attempt}-${randomUUID()}.json`);
  try { await rename(join(dir, 'player-verification.json'), destination); return destination; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return null;
}
