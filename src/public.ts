import type { Case, Command, State } from './model.js';

type Entity = 'locations' | 'characters' | 'knowledge' | 'evidence' | 'claims' | 'actions' | 'inferences';
const prefixes: Record<Entity, string> = { locations: 'l', characters: 'p', knowledge: 'k', evidence: 'e', claims: 't', actions: 'a', inferences: 'd' };
export function publicId(c: Case, kind: Entity, internal: string): string {
  const index = c[kind].findIndex(x => x.id === internal);
  if (index < 0) throw new Error(`Unknown ${kind} reference`);
  return prefixes[kind] + (index + 1);
}
function internalId(c: Case, kind: Entity, handle: unknown): string | null {
  if (typeof handle !== 'string' || !new RegExp(`^${prefixes[kind]}[1-9][0-9]*$`).test(handle)) return null;
  return c[kind][Number(handle.slice(1)) - 1]?.id ?? null;
}
function stableHash(text: string): number {
  let h = 2166136261;
  for (let n = 0; n < text.length; n++) { h ^= text.charCodeAt(n); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// Ordering uses only case/node identity and original position; never solutions or correctness-bearing option IDs.
export function orderedOptions(c: Case, i: Case['inferences'][number]) {
  return i.options.map((o, n) => ({ o, n, key: stableHash(`${c.id}:${i.id}:${n}`) }))
    .sort((a, b) => a.key - b.key || a.n - b.n).map(({ o }, n) => ({ choice: String(n + 1), text: o.text, internalId: o.id }));
}
export function resolvePlayerCommand(c: Case, s: State, input: unknown): Command | null {
  if (!input || typeof input !== 'object') return null;
  const x = input as Record<string, unknown>;
  const id = internalId(c, x.kind === 'move' ? 'locations' : x.kind === 'act' ? 'actions' : x.kind === 'press' ? 'claims' : 'inferences', x.id);
  if (!id) return null;
  if (x.kind === 'move' || x.kind === 'act' || x.kind === 'press') return { kind: x.kind, id };
  if (x.kind !== 'reason' && x.kind !== 'present') return null;
  if (!Array.isArray(x.evidenceIds) || x.evidenceIds.some(e => typeof e !== 'string')) return null;
  const evidenceIds = x.evidenceIds.map(e => internalId(c, 'evidence', e));
  if (evidenceIds.some(e => !e)) return null;
  const i = c.inferences.find(i => i.id === id)!;
  const option = orderedOptions(c, i).find(o => o.choice === x.optionId);
  if (!option) return null;
  if (x.kind === 'reason') return { kind: 'reason', id, optionId: option.internalId, evidenceIds: evidenceIds as string[] };
  const claimId = internalId(c, 'claims', x.claimId);
  if (!claimId || i.claimId !== claimId) return null;
  return { kind: 'present', id, claimId, optionId: option.internalId, evidenceIds: evidenceIds as string[] };
}
