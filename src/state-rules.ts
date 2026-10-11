import type { Case, Condition, State, StateV2 } from './model.js';

export const satisfies = (state: State, condition: Condition): boolean =>
  (['knowledge', 'evidence', 'claims', 'flags'] as const).every(key => condition[key].every(id => state[key].includes(id)));

export function isV2State(state: State): state is StateV2 {
  return 'pressed' in state && 'refuted' in state && 'moods' in state;
}

export function activeClaim(c: Case, state: State, id: string): boolean {
  const refuted = isV2State(state) && state.refuted.includes(id);
  return state.claims.includes(id) && !refuted &&
    !(c.version === '2.0' && c.claims.some(x => state.claims.includes(x.id) && x.replacesClaimId === id));
}
