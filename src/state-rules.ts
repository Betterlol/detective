import type { Case, Condition, State } from './model.js';

export const satisfies = (state: State, condition: Condition): boolean =>
  (['knowledge', 'evidence', 'claims', 'flags'] as const).every(key => condition[key].every(id => state[key].includes(id)));

export function activeClaim(c: Case, state: State, id: string): boolean {
  return state.claims.includes(id) && !(state.refuted || []).includes(id) &&
    !(c.version === '2.0' && c.claims.some(x => state.claims.includes(x.id) && x.replacesClaimId === id));
}
