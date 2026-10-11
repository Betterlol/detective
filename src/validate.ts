import type { Case } from './model.js';
import { validate } from './case-validation.js';
import { search } from './state-search.js';
export { validate } from './case-validation.js';
export { search } from './state-search.js';
export { replay, type TraceStep } from './trace.js';
export { inferenceEvidence } from './inference-evidence.js';
export type { Issue } from './validation-types.js';

export function audit(input: unknown, limit = 100_000) {
  const validation = validate(input);
  if (!validation.case || validation.issues.some(x => x.severity !== 'warning'))
    return { ok: false, issues: validation.issues, search: null };
  const result = search(validation.case, limit);
  return { ok: result.ok, issues: [...validation.issues, ...result.issues], search: result };
}
