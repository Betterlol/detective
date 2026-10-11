import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('生成锁记录无效');
  try { process.kill(pid, 0); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; return true; }
}

export async function acquireGenerationLease(out: string) {
  const path = join(out, 'generation-lock.json'), token = randomUUID();
  let file;
  try { file = await open(path, 'wx'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const saved = JSON.parse(await readFile(path, 'utf8')) as { pid: number };
    if (alive(saved.pid)) throw new Error('该实验的作者进程仍在运行，不能并发续修');
    await unlink(path);
    file = await open(path, 'wx');
  }
  try { await file.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })); }
  finally { await file.close(); }
  return async () => {
    const saved = JSON.parse(await readFile(path, 'utf8')) as { token: string };
    if (saved.token !== token) throw new Error('生成锁所有者意外变化');
    await unlink(path);
  };
}
