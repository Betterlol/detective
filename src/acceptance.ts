import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { caseSchema, type Case } from './model.js';
import { audit, inferenceEvidence, replay } from './validate.js';
import { hash, readJson, saveJson } from './io.js';
import { reviewAccepted, reviewSchema } from './review.js';

type MutationReport = { ok: boolean; sourceCaseHash: string; results: { name: string; expectedCode: string; detected: boolean }[] };

export async function mutationChecks(c: Case, dir: string) {
  const tests: { name: string; mutate: (copy: Case) => void; code: string }[] = [
    { name: 'dangling-reference', mutate: x => { x.actions[0]!.targetId = 'missing_entity'; }, code: 'reference' },
    { name: 'illegal-effect', mutate: x => { (x.actions[0]!.effects[0] as { kind: string }).kind = 'erase_truth'; }, code: 'schema' },
    { name: 'unobtainable-evidence', mutate: x => {
      const required = x.inferences[0]!.solutions[0]!.evidenceIds[0]!;
      x.flags.push('mutation_only');
      x.actions.forEach(a => a.effects.forEach(e => { if (e.kind === 'evidence' && e.id === required) { e.kind = 'flag'; e.id = 'mutation_only'; } }));
    }, code: 'unreachable-evidence' },
    { name: 'invisible-premise', mutate: x => {
      const id = x.inferences[0]!.argument.premises[0]!.knowledgeId;
      x.knowledge.find(k => k.id === id)!.text = '人为缺陷：玩家没有看到必要细节。';
    }, code: 'invisible-premise' },
    { name: 'conclusion-bypass', mutate: x => { x.actions[0]!.effects.push({ kind: 'knowledge', id: x.inferences[0]!.conclusionKnowledgeId }); }, code: 'bypass' },
  ];
  const results = [];
  for (const t of tests) {
    const copy = structuredClone(c); t.mutate(copy);
    const report = audit(copy), detected = report.issues.some(i => i.code === t.code);
    await saveJson(join(dir, t.name, 'case.json'), copy); await saveJson(join(dir, t.name, 'audit.json'), report);
    results.push({ name: t.name, expectedCode: t.code, detected, issues: report.issues });
  }
  const result = { kind: 'injected-mutations-not-natural-failures', sourceCaseHash: hash(c), ok: results.every(x => x.detected), results };
  await saveJson(join(dir, 'mutations.json'), result); console.log(`缺陷检验 ${results.filter(x => x.detected).length}/${results.length}`); return result;
}

export async function acceptance(root: string) {
  const cases = [], experiments = [], problems: string[] = [];
  let repaired = false;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let manifest: { kind: string; theme: string; status: string; attempts: { index: number; status: string; kind: string }[]; acceptedAttempt: number | null; acceptedCaseHash: string | null };
    try { manifest = await readJson(join(dir, 'manifest.json')) as typeof manifest; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    experiments.push({ directory: entry.name, ...manifest });
    if (manifest.status !== 'accepted' || manifest.acceptedAttempt === null) continue;
    const c = caseSchema.parse(await readJson(join(dir, 'case.json'))), a = audit(c);
    const storedReplay = await readJson(join(dir, 'replay.json')) as { steps: { command: Parameters<typeof replay>[1][number] }[] };
    const freshReplay = replay(c, storedReplay.steps.map(x => x.command));
    const evidenceSheet = inferenceEvidence(c, freshReplay);
    await saveJson(join(dir, 'inference-evidence.json'), evidenceSheet);
    const review = reviewSchema.parse(await readJson(join(dir, 'review.json')));
    const acceptedDir = join(dir, `attempt-${manifest.acceptedAttempt}`);
    const original = JSON.parse(await readFile(join(acceptedDir, 'raw.json'), 'utf8'));
    const originalReview = JSON.parse(await readFile(join(acceptedDir, 'review', 'raw.json'), 'utf8'));
    const provenance = hash(c) === manifest.acceptedCaseHash && hash(original) === hash(c) && hash(review) === hash(originalReview);
    const reproducible = hash(freshReplay) === hash(storedReplay);
    const visiblePremises = evidenceSheet.every(x => x.premises.every(p => p.visibleBeforeReasoning) && x.prerequisites.every(p => p.presentBeforeReasoning));
    const passed = a.ok && freshReplay.ended && reviewAccepted(c, review) && provenance && reproducible && visiblePremises;
    await saveJson(join(dir, 'verification.json'), { ok: passed, caseHash: hash(c), provenance, reproducible, visiblePremises, audit: a });
    if (!passed) problems.push(`${entry.name} 重新验收失败`);
    if (manifest.kind === 'natural-generation') cases.push({ directory: entry.name, theme: c.theme, title: c.title, ok: passed, states: a.search?.states, probes: a.search?.probes, exhaustive: a.search?.exhaustive, steps: freshReplay.steps.length, acceptedAttempt: manifest.acceptedAttempt, caseHash: hash(c) });
    if (manifest.attempts.some(x => x.kind === 'repair' && x.status === 'accepted')) repaired = true;
  }
  if (cases.filter(x => x.ok).length < 3) problems.push('少于3个真实生成且重新通过验收的主题案件');
  if (new Set(cases.filter(x => x.ok).map(x => x.theme)).size < 3) problems.push('主题数不足3；文字不同的实质差异另见质量报告');
  if (!repaired) problems.push('缺少实际模型反馈修复成功记录');
  let mutation: MutationReport | null = null;
  try { mutation = await readJson(join(root, 'defects', 'mutations.json')) as MutationReport; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (mutation) {
    for (const item of mutation.results) {
      const checked = audit(await readJson(join(root, 'defects', item.name, 'case.json')));
      item.detected = checked.issues.some(x => x.code === item.expectedCode);
      await saveJson(join(root, 'defects', item.name, 'verification.json'), checked);
    }
    mutation.ok = mutation.results.every(x => x.detected) &&
      mutation.results.some(x => x.expectedCode === 'reference') && mutation.results.some(x => x.expectedCode === 'unreachable-evidence');
  }
  if (!mutation?.ok) problems.push('缺少通过的故意破坏样例检验');
  const natural = experiments.filter(x => x.kind === 'natural-generation');
  const summary = {
    version: 'acceptance-1.0', verifiedAt: new Date().toISOString(), ok: problems.length === 0, problems,
    naturalExperiments: natural.length, naturalAttempts: natural.reduce((n, x) => n + x.attempts.length, 0),
    firstAttemptAccepted: natural.filter(x => x.status === 'accepted' && x.acceptedAttempt === 0).length,
    repairedAccepted: natural.filter(x => x.status === 'accepted' && (x.acceptedAttempt ?? 0) > 0).length,
    failedExperiments: natural.filter(x => x.status === 'failed').length,
    validationFailedAttempts: natural.flatMap(x => x.attempts).filter(x => x.status === 'validation-failed').length,
    reviewFailedAttempts: natural.flatMap(x => x.attempts).filter(x => x.status === 'review-failed').length,
    callOrParseFailedAttempts: natural.flatMap(x => x.attempts).filter(x => x.status === 'call-or-parse-failed').length,
    injectedRepairExperiments: experiments.filter(x => x.kind === 'injected-defect-repair').length,
    cases, experiments, mutation,
    limits: '自动汇总不能证明叙事/自然语言推理正确。独立 AI 评价与根 Agent 文本核对见 QUALITY_REPORT.md；三主题不代表广泛稳定性。',
  };
  await saveJson(join(root, 'acceptance.json'), summary);
  console.log(JSON.stringify({ ok: summary.ok, problems, cases, naturalAttempts: summary.naturalAttempts, failedExperiments: summary.failedExperiments }, null, 2)); return summary;
}
