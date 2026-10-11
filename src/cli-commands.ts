import type { ParsedCliArguments } from './cli-args.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join, dirname, relative, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { caseSchema, jsonSchema, legacyJsonSchema, type Command } from './model.js';
import { generate } from './generate.js';
import { audit, replay } from './validate.js';
import { initialState, opening, playerView, transition } from './engine.js';
import { hash, readJson, saveJson } from './io.js';
import { resolvePlayerCommand } from './public.js';

type CommandContext = { args: ParsedCliArguments; flag: (name: string, fallback?: string) => string | undefined };
type CommandHandler = (context: CommandContext) => Promise<void>;

async function runSchema(context: CommandContext) {
  const { args, flag } = context;
  const version = flag('version', '2.0');
  if (version !== '1.0' && version !== '2.0') throw new Error('schema 版本必须是 1.0 或 2.0');
  const output = args.positionals[0] || (version === '1.0' ? 'schema/case.schema.json' : 'schema/case-v2.schema.json');
  await saveJson(output!, version === '1.0' ? legacyJsonSchema : jsonSchema);
  return;
}

async function runBlind(context: CommandContext) {
  const { args, flag } = context;
  const out = flag('out');
  if (!args.positionals[0] || !out) throw new Error('blind 案件.json --out 新试玩目录 [--bind]');
  const c = caseSchema.parse(await readJson(args.positionals[0]));
  if (!audit(c).ok) throw new Error('案件未通过基础检查');
  try { await access(out); throw new Error('试玩目录已存在，请使用新目录以保留历史'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const binding = relative(resolve(dirname(args.positionals[0])), resolve(out));
  if (args.hasFlag('bind') && !/^[\w-]+$/.test(binding)) throw new Error('绑定试玩必须存于案件目录下的新直接子目录');
  const { blindPlay } = await import('./blind-player.js');
  const { modelConfig } = await import('./provider.js');
  const config = modelConfig();
  await saveJson(join(out, 'provenance.json'), { caseHash: hash(c), config, startedAt: new Date().toISOString() });
  const result = await blindPlay(c, out, config);
  if (result.ok && args.hasFlag('bind')) await saveJson(join(dirname(args.positionals[0]), 'player-verification.json'), {
    caseHash: hash(c), directory: binding, reason: '使用当前程序重新进行公开视角模型试玩；原生成试玩记录保留。',
  });
  console.log(JSON.stringify({ ok: result.ok, decisions: result.decisions.length, mistakes: result.reasoningMistakes, out }));
  if (!result.ok) process.exitCode = 1; return;
}

async function runGenerate(context: CommandContext) {
  const { args, flag } = context;
  const theme = flag('theme'), out = flag('out');
  if (!theme || !out) throw new Error('generate --theme "主题" --out experiments/新目录 [--constraints "约束"] [--repairs 2]');
  const source = flag('source');
  const manifest = await generate({ theme, out, constraints: flag('constraints', '微型完整中文案件；至少一处公平的关键推理')!,
    maxRepairs: Number(flag('repairs', '2')), maxDesignRepairs: Number(flag('design-repairs', '2')),
    source: source ? await readJson(source) : undefined, injected: args.hasFlag('injected') });
  console.log(JSON.stringify(manifest, null, 2)); if (manifest.status !== 'accepted') process.exitCode = 1; return;
}

async function runRepair(context: CommandContext) {
  const { args, flag } = context;
  const feedback = flag('feedback');
  if (!args.positionals[0] || !feedback) throw new Error('repair 实验目录 --feedback 反馈.json [--repairs 3]');
  const result = await generate({ theme: '', constraints: '', out: args.positionals[0], resume: true,
    feedback: await readJson(feedback), maxRepairs: flag('repairs') ? Number(flag('repairs')) : undefined,
    maxDesignRepairs: flag('design-repairs') ? Number(flag('design-repairs')) : undefined });
  console.log(JSON.stringify({ status: result.status, acceptedAttempt: result.acceptedAttempt }));
  if (result.status !== 'accepted') process.exitCode = 1; return;
}

async function runValidate(context: CommandContext) {
  const { args, flag } = context;
  if (!args.positionals[0]) throw new Error('validate 案件.json [--out 报告.json]');
  const result = audit(await readJson(args.positionals[0]), Number(flag('limit', '100000')));
  if (flag('out')) await saveJson(flag('out')!, result);
  console.log(JSON.stringify({ ok: result.ok, issues: result.issues, states: result.search?.states, exhaustive: result.search?.exhaustive, ended: result.search?.replay?.ended }, null, 2));
  if (!result.ok) process.exitCode = 1; return;
}

async function runReplay(context: CommandContext) {
  const { args, flag } = context;
  if (!args.positionals[0]) throw new Error('replay 案件.json [轨迹.json] [--out 新轨迹.json]');
  const c = caseSchema.parse(await readJson(args.positionals[0]));
  const prior = args.positionals[1] ? await readJson(args.positionals[1]) as { steps?: { command: Command }[]; commands?: Command[] } : null;
  const commands = prior ? prior.commands || prior.steps?.map(x => x.command) : audit(c).search?.commands;
  if (!commands) throw new Error('未找到轨迹');
  const result = replay(c, commands);
  console.log(result.opening.join('\n'));
  result.steps.forEach((s, n) => console.log(`\n[${n + 1}] ${JSON.stringify(s.command)}\n${s.text.join('\n')}`));
  if (flag('out')) await saveJson(flag('out')!, result);
  if (!result.ended) { process.exitCode = 1; console.log('轨迹未到达结局'); } return;
}

async function runPlay(context: CommandContext) {
  const { args, flag } = context;
  if (!args.positionals[0]) throw new Error('play 案件.json');
  const checked = audit(await readJson(args.positionals[0]));
  if (!checked.ok) throw new Error('案件未通过基础检查，请先 validate');
  const c = caseSchema.parse(await readJson(args.positionals[0])); let s = initialState(c);
  const rl = createInterface({ input: stdin, output: stdout }); const commands: Command[] = [];
  console.log(opening(c).join('\n'));
  console.log('输入 move 地点编号 / act 行动编号 / press 证词编号 / present 问题编号 证词编号 选项编号 证物编号,证物编号 / reason 问题编号 选项编号 证物编号,证物编号 / notebook / quit。错误尝试无惩罚。');
  try {
    while (!s.ended) {
      const view = playerView(c, s);
      console.log(`\n当前位置：${view.location!.name}`);
      console.log('地点：' + view.locations.map(x => `${x.id}（${x.name}）`).join(' / '));
      console.log('调查：' + view.actions.map(x => `${x.id}（${x.label}${x.completed ? '；已调查' : ''}）`).join(' / '));
      console.log('追问：' + view.presses.filter(x => !x.completed).map(x => `${x.id}（${x.text}）`).join(' / '));
      for (const i of view.inferences.filter(x => !x.solved)) {
        console.log(`问题 ${i.id}${i.claimId ? `，针对证词 ${i.claimId}` : ''}：${i.question}`); for (const o of i.options) console.log(`  ${o.choice}：${o.text}`);
      }
      const answer = (await rl.question('> ')).trim();
      if (answer === 'quit') break;
      if (answer === 'notebook') { console.log(JSON.stringify({ knowledge: view.knowledge, evidence: view.evidence, claims: view.claims }, null, 2)); continue; }
      const [kind, id, arg1, arg2, arg3] = answer.split(/\s+/);
      const input = kind === 'move' || kind === 'act' || kind === 'press' ? { kind, id } :
        kind === 'reason' ? { kind, id, optionId: arg1, evidenceIds: arg2 ? arg2.split(',') : [] } :
        kind === 'present' ? { kind, id, claimId: arg1, optionId: arg2, evidenceIds: arg3 ? arg3.split(',') : [] } : null;
      const cmd = resolvePlayerCommand(c, s, input);
      if (!cmd) { console.log('请按提示输入。'); continue; }
      const result = transition(c, s, cmd); console.log(result.text.join('\n')); s = result.state;
      if (result.ok && result.status !== 'repeat') commands.push(cmd);
    }
    if (flag('save')) await saveJson(flag('save')!, { commands, ended: s.ended });
  } finally { rl.close(); }
  return;
}

async function runAcceptance(context: CommandContext) {
  const { args, flag } = context;
  const { acceptance } = await import('./acceptance.js'); const r = await acceptance(args.positionals[0] || 'experiments/v2', args.hasFlag('legacy')); if (!r.ok) process.exitCode = 1; return;
}

async function runReport(context: CommandContext) {
  const { args, flag } = context;
  const { experimentReport } = await import('./experiment-report.js'); const r = await experimentReport(args.positionals[0] || 'experiments/v2'); console.log(JSON.stringify({ calls: r.callCount, completed: r.completedCalls })); return;
}

async function runMutate(context: CommandContext) {
  const { args, flag } = context;
  const { mutationChecks } = await import('./acceptance.js'); if (!args.positionals[0]) throw new Error('mutate 案件.json --out defects/目录'); const c = caseSchema.parse(await readJson(args.positionals[0])); await mutationChecks(c, flag('out', join('experiments', 'defects'))!); return;
}

const handlers: Record<string, CommandHandler> = {
  schema: runSchema,
  blind: runBlind,
  generate: runGenerate,
  repair: runRepair,
  validate: runValidate,
  replay: runReplay,
  play: runPlay,
  acceptance: runAcceptance,
  report: runReport,
  mutate: runMutate,
};

export async function runCliCommand(command: string | undefined, args: ParsedCliArguments) {
  const context: CommandContext = { args, flag: (name, fallback) => args.option(name, fallback) };
  const handler = command ? handlers[command] : undefined;
  if (handler) return handler(context);
  console.log('用法：npm run lab -- schema [--version 1.0|2.0] [输出文件] | generate | repair | validate | replay | play | blind | mutate | acceptance | report。详见 README。');
}
