import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';
import { caseSchema, jsonSchema, type Command } from './model.js';
import { generate } from './generate.js';
import { audit, replay } from './validate.js';
import { initialState, opening, playerView, transition } from './engine.js';
import { readJson, saveJson } from './io.js';

const [command, ...args] = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const n = args.indexOf('--' + name); return n >= 0 ? args[n + 1] : fallback; };
async function main() {
  if (command === 'schema') { await saveJson(args[0] || 'schema/case.schema.json', jsonSchema); return; }
  if (command === 'generate') {
    const theme = flag('theme'), out = flag('out');
    if (!theme || !out) throw new Error('generate --theme "主题" --out experiments/新目录 [--constraints "约束"] [--repairs 2]');
    const source = flag('source');
    const manifest = await generate({ theme, out, constraints: flag('constraints', '微型完整中文案件；至少一处公平的关键推理')!,
      maxRepairs: Number(flag('repairs', '2')), source: source ? await readJson(source) : undefined, injected: args.includes('--injected') });
    console.log(JSON.stringify(manifest, null, 2)); if (manifest.status !== 'accepted') process.exitCode = 1; return;
  }
  if (command === 'validate') {
    if (!args[0]) throw new Error('validate 案件.json [--out 报告.json]');
    const result = audit(await readJson(args[0]), Number(flag('limit', '100000')));
    if (flag('out')) await saveJson(flag('out')!, result);
    console.log(JSON.stringify({ ok: result.ok, issues: result.issues, states: result.search?.states, exhaustive: result.search?.exhaustive, ended: result.search?.replay?.ended }, null, 2));
    if (!result.ok) process.exitCode = 1; return;
  }
  if (command === 'replay') {
    if (!args[0]) throw new Error('replay 案件.json [轨迹.json] [--out 新轨迹.json]');
    const c = caseSchema.parse(await readJson(args[0]));
    const prior = args[1] && !args[1].startsWith('--') ? await readJson(args[1]) as { steps?: { command: Command }[]; commands?: Command[] } : null;
    const commands = prior ? prior.commands || prior.steps?.map(x => x.command) : audit(c).search?.commands;
    if (!commands) throw new Error('未找到轨迹');
    const result = replay(c, commands);
    console.log(result.opening.join('\n'));
    result.steps.forEach((s, n) => console.log(`\n[${n + 1}] ${JSON.stringify(s.command)}\n${s.text.join('\n')}`));
    if (flag('out')) await saveJson(flag('out')!, result);
    if (!result.ended) { process.exitCode = 1; console.log('轨迹未到达结局'); } return;
  }
  if (command === 'play') {
    if (!args[0]) throw new Error('play 案件.json');
    const checked = audit(await readJson(args[0]));
    if (!checked.ok) throw new Error('案件未通过基础检查，请先 validate');
    const c = caseSchema.parse(await readJson(args[0])); let s = initialState(c);
    const rl = createInterface({ input: stdin, output: stdout }); const commands: Command[] = [];
    console.log(opening(c).join('\n'));
    console.log('输入 move 地点ID / act 行动ID / reason 推理ID 选项ID 证物ID,证物ID / notebook / quit。错误尝试无惩罚。');
    try {
      while (!s.ended) {
        const view = playerView(c, s);
        console.log(`\n当前位置：${view.location!.name}`);
        console.log('地点：' + view.locations.map(x => `${x.id}（${x.name}）`).join(' / '));
        console.log('调查：' + view.actions.map(x => `${x.id}（${x.label}${x.completed ? '；已调查' : ''}）`).join(' / '));
        for (const i of view.inferences.filter(x => !x.solved)) {
          console.log(`推理 ${i.id}：${i.question}`); for (const o of i.options) console.log(`  ${o.id}：${o.text}`);
        }
        const answer = (await rl.question('> ')).trim();
        if (answer === 'quit') break;
        if (answer === 'notebook') { console.log(JSON.stringify({ knowledge: view.knowledge, evidence: view.evidence, claims: view.claims }, null, 2)); continue; }
        const [kind, id, optionId, evidence] = answer.split(/\s+/);
        const cmd: Command | null = kind === 'move' && id ? { kind, id } : kind === 'act' && id ? { kind, id } : kind === 'reason' && id && optionId ? { kind, id, optionId, evidenceIds: evidence ? evidence.split(',') : [] } : null;
        if (!cmd) { console.log('请按提示输入。'); continue; }
        const result = transition(c, s, cmd); console.log(result.text.join('\n')); s = result.state;
        if (result.ok && result.status !== 'repeat') commands.push(cmd);
      }
      if (flag('save')) await saveJson(flag('save')!, { commands, ended: s.ended });
    } finally { rl.close(); }
    return;
  }
  if (command === 'acceptance') { const { acceptance } = await import('./acceptance.js'); const r = await acceptance(args[0] || 'experiments'); if (!r.ok) process.exitCode = 1; return; }
  if (command === 'mutate') { const { mutationChecks } = await import('./acceptance.js'); if (!args[0]) throw new Error('mutate 案件.json --out defects/目录'); const c = caseSchema.parse(await readJson(args[0])); await mutationChecks(c, flag('out', join('experiments', 'defects'))!); return; }
  console.log('用法：npm run lab -- schema | generate | validate | replay | play | mutate | acceptance。详见 README。');
}
main().catch(e => { console.error(String(e)); process.exitCode = 1; });
