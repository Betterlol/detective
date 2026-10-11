import { readdir, readFile, mkdir, copyFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { auditDesign } from './design-validation.js';
import { reviewDesign, designReviewPromptVersion } from './design-review.js';
import { hash, readJson, saveJson } from './io.js';
import type { DetectiveConfig } from './config.js';
import { modelConfig } from './provider.js';
import { ModelCallError } from './sdk-run.js';
import { randomUUID } from 'node:crypto';

export async function foundationReviewKey(designHash: string, settings: DetectiveConfig) {
  return hash({ design: designHash, config: modelConfig(settings), version: designReviewPromptVersion,
    template: await readFile(new URL('../prompts/review-design.md', import.meta.url), 'utf8') });
}

// The author sandbox only exchanges JSON files. SDK/model processes are launched by the application.
export function startFoundationBroker(workspace: string, settings: DetectiveConfig, maximum: number, reviewer: typeof reviewDesign = reviewDesign) {
  const controller = new AbortController(); let pending: Promise<void> = Promise.resolve();
  const startedAt = Date.now(), seen = new Map<string, string>(); let used = 0;
  async function scan() {
    const folder = join(workspace, '.detective-tools', 'review-requests');
    let names: string[];
    try { names = await readdir(folder); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    for (const name of names.filter(x => /^[a-f0-9]+\.json$/.test(x))) {
      const responsePath = join(workspace, '.detective-tools', 'review-responses', name);
      let requestId: string | undefined;
      try {
        const request = await readJson(join(folder, name)) as { design: unknown; key: string; requestId: string; createdAt: number };
        // Persistent files are evidence, not fresh authorization to start another review.
        if (!request.requestId || request.createdAt < startedAt || seen.get(name) === request.requestId) continue;
        seen.set(name, request.requestId); requestId = request.requestId;
        const checked = auditDesign(request.design);
        if (!checked.ok || !checked.design || request.key + '.json' !== name ||
          request.key !== await foundationReviewKey(hash(request.design), settings)) throw new Error('评审请求与当前设计/配置不匹配');
        if (!settings.workflow.foundationReview) { await saveJson(responsePath, { requestId, skipped: true }); continue; }
        const directory = join(workspace, '.detective-tools', 'reviews', request.key);
        let review;
        try { review = await readJson(join(directory, 'review.json')); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          if (used >= maximum) throw new Error('隔离设计评审预算已耗尽'); used++;
          // Reusing a failed request key must not overwrite its original transport/event evidence.
          try {
            await access(join(directory, 'request.json'));
            const archive = join(directory, 'failed-' + randomUUID()); await mkdir(archive, { recursive: true });
            for (const file of ['request.json', 'prompt.md', 'schema.json', 'events.jsonl', 'transport.json', 'raw.json'])
              await copyFile(join(directory, file), join(archive, file)).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
          } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
          review = await reviewer(checked.design, directory, modelConfig(settings));
        }
        await saveJson(responsePath, { requestId, review });
      } catch (e) { await saveJson(responsePath, { requestId, error: String(e), failureKind: e instanceof ModelCallError ? 'model-transport' : 'tool-execution' }); }
    }
  }
  const timer = setInterval(() => { pending = pending.then(() => { if (!controller.signal.aborted) return scan(); }).catch(async e => {
    await saveJson(join(workspace, '.detective-tools', 'broker-failure.json'), { error: String(e) });
  }); }, 200);
  return async () => { controller.abort(); clearInterval(timer); await pending; };
}

export async function requestFoundationReview(workspace: string, design: unknown, settings: DetectiveConfig) {
  const key = await foundationReviewKey(hash(design), settings), requestId = randomUUID();
  await saveJson(join(workspace, '.detective-tools', 'review-requests', key + '.json'), { key, design, requestId, createdAt: Date.now() });
  const deadline = Date.now() + settings.model.timeoutMs + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await readJson(join(workspace, '.detective-tools', 'review-responses', key + '.json')) as
        { requestId?: string; review?: Awaited<ReturnType<typeof reviewDesign>>; error?: string; failureKind?: string };
      if (response.requestId === requestId) {
        if (response.error) throw new Error(`${response.failureKind}: ${response.error}`);
        if (!response.review) throw new Error('隔离评审未返回结构化结果');
        return response.review;
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('tool-execution: 设计评审请求等待超时（应用 broker 未响应）');
}
