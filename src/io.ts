import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')); }
export async function saveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }); }
}
export async function saveText(path: string, value: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value, 'utf8'); }
export const hash = (x: unknown): string => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
