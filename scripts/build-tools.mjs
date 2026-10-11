import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

await promisify(execFile)(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'),
  '--project', fileURLToPath(new URL('../tsconfig.tools.json', import.meta.url))], { windowsHide: true });
const { sourceValidationVersion } = await import('../dist/validation-cache.js');
await writeFile(new URL('../dist/tool-source.json', import.meta.url), JSON.stringify({ version: await sourceValidationVersion() }) + '\n');
