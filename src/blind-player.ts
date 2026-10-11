import { z } from 'zod';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Case, State } from './model.js';
import { initialState, opening, playerView, transition } from './engine.js';
import { publicId, resolvePlayerCommand } from './public.js';
import { renderPrompt } from './prompt-template.js';
import { callModel, type ModelConfig } from './provider.js';
import { hash, saveJson } from './io.js';

export const playerDecisionSchema = z.object({
  command: z.object({ kind: z.enum(['reason', 'present']), id: z.string(), claimId: z.string().nullable(),
    optionId: z.string(), evidenceIds: z.array(z.string()) }).strict(),
  reasoning: z.string().min(1),
}).strict();

export type PublicEvent = { command: unknown; status: string; ok: boolean; text: string[] };
export function playerPacket(c: Case, s: State, transcript: PublicEvent[]) {
  return { opening: opening(c), view: playerView(c, s), transcript: structuredClone(transcript) };
}
export const playerPromptVersion = 'player-2.0';
export async function playerPrompt(input: ReturnType<typeof playerPacket>, targetId: string) {
  if (!input.view.inferences.some(x => x.id === targetId)) throw new Error('Target must be a visible public inference ID');
  const template = await readFile(new URL('../prompts/player-v2.md', import.meta.url), 'utf8');
  return renderPrompt(template, { version: playerPromptVersion, targetId, playerInput: JSON.stringify(input) });
}
export function replayPublic(c: Case, transcript: PublicEvent[]) {
  let state = initialState(c);
  for (const event of transcript) {
    const command = resolvePlayerCommand(c, state, event.command);
    const r = command ? transition(c, state, command) : { ok: false, status: 'invalid-public-command', state, text: ['请使用当前公开编号与选项序号。'] };
    if (r.ok !== event.ok || r.status !== event.status || JSON.stringify(r.text) !== JSON.stringify(event.text))
      throw new Error('公开试玩轨迹与真实运行器重放不一致');
    state = r.state;
  }
  return { ended: state.ended, finalState: state };
}
export type BlindRecord = { ok: boolean; transcript: PublicEvent[]; finalState: State;
  decisions: { input: ReturnType<typeof playerPacket>; output: { command: unknown }; result: PublicEvent }[] };
export function blindTranscriptValid(c: Case, record: BlindRecord): boolean {
  try {
    const played = replayPublic(c, record.transcript);
    if (!record.ok || !played.ended || hash(played.finalState) !== hash(record.finalState)) return false;
    const indices = record.transcript.flatMap((event, index) => {
      const kind = (event.command as { kind?: unknown } | null)?.kind;
      return kind === 'reason' || kind === 'present' ? [index] : [];
    });
    if (!indices.length || indices.length !== record.decisions.length) return false;
    return record.decisions.every((decision, n) => {
      const index = indices[n]!, prefix = record.transcript.slice(0, index), next = record.transcript[index]!;
      const before = replayPublic(c, prefix).finalState;
      return hash(playerPacket(c, before, prefix)) === hash(decision.input) &&
        hash(next) === hash(decision.result) && hash(next.command) === hash(decision.output.command);
    });
  } catch { return false; }
}
export async function blindPlay(c: Case, dir: string, config: ModelConfig, maxDecisions = 12) {
  let state = initialState(c), steps = 0;
  const transcript: PublicEvent[] = [], decisions: { input: ReturnType<typeof playerPacket>; output: z.infer<typeof playerDecisionSchema>; result: PublicEvent }[] = [];
  const mistakes = new Map<string, number>();
  function execute(input: unknown) {
    const command = resolvePlayerCommand(c, state, input);
    const r = command ? transition(c, state, command) : { ok: false, status: 'invalid-public-command', state, text: ['请使用当前公开编号与选项序号。'] };
    const event = { command: input, status: r.status, ok: r.ok, text: r.text };
    state = r.state; steps++; transcript.push(event); return event;
  }
  // Investigation is an exhaustive public-action driver; only reasoning is delegated to the model.
  // No solutions, author premise maps, or omniscient search result are ever used to select a move.
  while (!state.ended && decisions.length < maxDecisions && steps < 160) {
    let activity = false;
    const questions: { locationId: string; inferenceId: string }[] = [];
    const locations = playerView(c, state).locations;
    for (const loc of locations) {
      if (state.ended) break;
      if (playerView(c, state).location.id !== loc.id) execute({ kind: 'move', id: loc.id });
      for (let n = 0; n < 40; n++) {
        const view = playerView(c, state);
        const action = view.actions.find(x => !x.completed);
        const press = view.presses.find(x => !x.completed);
        if (action) { execute({ kind: 'act', id: action.id }); activity = true; }
        else if (press) { execute({ kind: 'press', id: press.id }); activity = true; }
        else break;
      }
      for (const i of playerView(c, state).inferences.filter(x => !x.solved)) questions.push({ locationId: loc.id, inferenceId: i.id });
    }
    if (state.ended) break;
    const pending = questions.find(x => (mistakes.get(x.inferenceId) || 0) < 3);
    if (!pending) { if (!activity) break; continue; }
    if (playerView(c, state).location.id !== pending.locationId) execute({ kind: 'move', id: pending.locationId });
    const input = playerPacket(c, state, transcript);
    const prompt = await playerPrompt(input, publicId(c, 'inferences', pending.inferenceId));
    const callDir = join(dir, `decision-${decisions.length}`);
    const raw = await callModel(prompt, z.toJSONSchema(playerDecisionSchema), callDir, config);
    const output = playerDecisionSchema.parse(JSON.parse(raw));
    const result = execute(output.command);
    decisions.push({ input, output, result });
    if (!result.ok) mistakes.set(pending.inferenceId, (mistakes.get(pending.inferenceId) || 0) + 1);
    await saveJson(join(dir, 'progress.json'), { ended: state.ended, decisions, transcript });
  }
  const result = { ok: state.ended, ended: state.ended, steps, decisions, transcript, finalState: state,
    reasoningMistakes: decisions.filter(x => !x.result.ok).length,
    method: '公开界面驱动穷尽调查/追问，模型仅凭已获文本决定论证与出示；无作者答案、真相或搜索路径输入。',
    limits: '调查由程序驱动，非完整自主玩家或人类试玩；最多12次推理判断、每题最多3次失败。',
  };
  await saveJson(join(dir, 'playtest.json'), result); return result;
}
