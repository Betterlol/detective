import { join, resolve } from 'node:path';
import { readJson, saveText } from '../src/io.js';
import { caseV2Schema } from '../src/model.js';
import { publicId } from '../src/public.js';
import type { replay } from '../src/trace.js';

const root = resolve(process.argv[2] ?? 'experiments/agent-tools-20261011');
for (const name of ['theatre-1', 'theatre-2', 'radio-1', 'radio-2', 'greenhouse-1', 'greenhouse-2']) {
  const dir = join(root, name);
  const manifest = await readJson(join(dir, 'manifest.json')) as { status: string };
  if (manifest.status !== 'accepted') continue;
  const c = caseV2Schema.parse(await readJson(join(dir, 'case.json')));
  const trace = await readJson(join(dir, 'replay.json')) as ReturnType<typeof replay>;
  const lines = [`# ${c.title}`, '', ...trace.opening.flatMap(text => [text, ''])];
  for (const [n, step] of trace.steps.entries()) {
    const cmd = step.command, view = step.playerBefore;
    const label = cmd.kind === 'move' ? c.locations.find(x => x.id === cmd.id)!.name : cmd.kind === 'act' ? c.actions.find(x => x.id === cmd.id)!.label :
      cmd.kind === 'press' ? '追问当前陈述' : '提交推理';
    lines.push(`## 第${n + 1}步：${label}`, '');
    // Include every problem available at that actual point, with neutral player handles and option order.
    for (const i of view.inferences.filter(x => !x.solved)) {
      lines.push(`${i.id}：${i.question}`, '', ...i.options.map(o => `${o.choice}. ${o.text}`), '');
    }
    if (cmd.kind === 'present' || cmd.kind === 'reason') {
      const inference = c.inferences.find(x => x.id === cmd.id)!;
      const selected = inference.options.find(x => x.id === cmd.optionId)!;
      lines.push(`本次选择：${selected.text}`, `出示证物：${cmd.evidenceIds.map(id => publicId(c, 'evidence', id)).join('、')}`, '');
    }
    lines.push(...step.text.flatMap(text => [text, '']));
  }
  await saveText(join(dir, 'player-replay.md'), lines.join('\n'));
}
