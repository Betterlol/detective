import { readFile } from 'node:fs/promises';
import { hash } from './io.js';

const files = ['model.ts', 'validate.ts', 'case-validation.ts', 'validate-v2.ts', 'design.ts',
  'design-validation.ts', 'state-search.ts', 'state-rules.ts', 'engine.ts', 'trace.ts',
  'public.ts', 'player-view.ts', 'inference-evidence.ts', 'author-tools.ts', 'validation-cache.ts', 'io.ts', 'foundation-broker.ts'];
export async function sourceValidationVersion() {
  return hash(await Promise.all(files.map(name => readFile(new URL(import.meta.url.endsWith('.js') ? '../src/' + name : name, import.meta.url), 'utf8'))));
}
export async function validationVersion() {
  const version = await sourceValidationVersion();
  if (import.meta.url.endsWith('.js')) {
    const built = JSON.parse(await readFile(new URL('./tool-source.json', import.meta.url), 'utf8')) as { version: string };
    if (built.version !== version) throw new Error('工具编译版本与当前源码不符；由应用重新构建，不接受旧检查结果');
  }
  return version;
}
export async function validationKey(designHash: string, caseHash: string | null, searchStateLimit: number) {
  return hash({ version: await validationVersion(), designHash, caseHash, searchStateLimit });
}
