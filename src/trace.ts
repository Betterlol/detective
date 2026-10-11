import type { Case, Command, State } from './model.js';
import { initialState, transition } from './engine.js';
import { opening, playerView } from './player-view.js';

export type TraceStep = { command: Command; status: string; text: string[]; before: State; after: State; playerBefore: ReturnType<typeof playerView> };
export function replay(c: Case, commands: Command[]) {
  let state = initialState(c);
  const steps: TraceStep[] = [];
  for (const command of commands) {
    const before = state, result = transition(c, state, command);
    steps.push({ command, status: result.status, text: result.text, before, after: result.state, playerBefore: playerView(c, before) });
    if (!result.ok) throw new Error(`回放失败 ${JSON.stringify(command)}: ${result.status}`);
    state = result.state;
  }
  return { opening: opening(c), steps, ended: state.ended, finalState: state };
}
