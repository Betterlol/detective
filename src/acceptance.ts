import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { caseSchema, type Case } from './model.js';
import { audit, inferenceEvidence, replay } from './validate.js';
import { hash, readJson, saveJson } from './io.js';
import { reviewAccepted, reviewSchema, reviewV2Schema } from './review.js';
import { blindTranscriptValid, playerPrompt, type BlindRecord } from './blind-player.js';

type MutationReport = { ok: boolean; sourceCaseHash: string; results: { name: string; expectedCode: string; detected: boolean }[] };

export async function mutationChecks(c: Case, dir: string) {
  const tests: { name: string; mutate: (copy: Case) => void; code: string }[] = [
    { name: 'dangling-reference', mutate: x => { x.actions[0]!.targetId = 'missing_entity'; }, code: 'reference' },
    { name: 'illegal-effect', mutate: x => { (x.actions[0]!.effects[0] as { kind: string }).kind = 'erase_truth'; }, code: 'schema' },
    { name: 'unobtainable-evidence', mutate: x => {
      const required = x.inferences[0]!.solutions[0]!.evidenceIds[0]!;
      x.flags.push('mutation_only');
      const block = (effects: { kind: string; id: string }[]) => effects.forEach(e => { if (e.kind === 'evidence' && e.id === required) { e.kind = 'flag'; e.id = 'mutation_only'; } });
      x.actions.forEach(a => block(a.effects));
      if (x.version === '2.0') { x.claims.forEach(t => { if (t.press) block(t.press.effects); }); x.inferences.forEach(i => block(i.effects)); }
    }, code: 'unreachable-evidence' },
    { name: 'invisible-premise', mutate: x => {
      const id = x.inferences[0]!.argument.premises[0]!.knowledgeId;
      x.knowledge.find(k => k.id === id)!.text = '人为缺陷：玩家没有看到必要细节。';
    }, code: 'invisible-premise' },
    { name: 'conclusion-bypass', mutate: x => { x.actions[0]!.effects.push({ kind: 'knowledge', id: x.inferences[0]!.conclusionKnowledgeId }); }, code: 'bypass' },
  ];
  if (c.version === '2.0') tests.push(
    { name: 'identity-ending-bypass', mutate: x => { if (x.version === '2.0') { const i = x.inferences.find(i => i.id === x.resolution.identityInferenceId)!; x.ending.requires.knowledge = x.ending.requires.knowledge.filter(k => k !== i.conclusionKnowledgeId); } }, code: 'identity-ending' },
    { name: 'identity-dependency-gap', mutate: x => { if (x.version === '2.0') { const i = x.inferences.find(i => i.id === x.resolution.identityInferenceId)!; const k = x.inferences.find(i => i.kind === 'mechanism')!.conclusionKnowledgeId; i.solutions.forEach(s => { s.knowledgeIds = s.knowledgeIds.filter(id => id !== k); }); } }, code: 'identity-dependency' },
    { name: 'revision-bypass', mutate: x => { if (x.version === '2.0') x.actions[0]!.effects.push({ kind: 'claim', id: x.claims.find(x => x.replacesClaimId)!.id }); }, code: 'revision-bypass' },
    { name: 'option-length-cue', mutate: x => { x.inferences[0]!.options[0]!.text = '人为缺陷的过长选项'.repeat(60); }, code: 'option-length-leak' },
  );
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

export async function acceptance(root: string, legacy = false) {
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
    const verificationDir = c.version === '1.0' ? join(dir, 'compatibility-v2') : dir;
    await saveJson(join(verificationDir, 'inference-evidence.json'), evidenceSheet);
    const review = (c.version === '2.0' ? reviewV2Schema : reviewSchema).parse(await readJson(join(dir, 'review.json')));
    const acceptedDir = join(dir, `attempt-${manifest.acceptedAttempt}`);
    const original = JSON.parse(await readFile(join(acceptedDir, 'raw.json'), 'utf8'));
    const originalReview = JSON.parse(await readFile(join(acceptedDir, 'review', 'raw.json'), 'utf8'));
    const provenance = hash(c) === manifest.acceptedCaseHash && hash(original) === hash(c) && hash(review) === hash(originalReview);
    const coreTrace = (x: ReturnType<typeof replay>) => ({ ...x, steps: x.steps.map(({ playerBefore, ...step }) => step) });
    const reproducible = c.version === '1.0' ? hash(coreTrace(freshReplay)) === hash(coreTrace(storedReplay as ReturnType<typeof replay>)) : hash(freshReplay) === hash(storedReplay);
    const publicViewMigrated = hash(freshReplay) !== hash(storedReplay);
    const visiblePremises = evidenceSheet.every(x => x.premises.every(p => p.visibleBeforeReasoning) && x.prerequisites.every(p => p.presentBeforeReasoning));
    let blindReproducible = legacy;
    let blindDecisions = 0, blindMistakes = 0;
    if (c.version === '2.0') {
      let playerDir = join(acceptedDir, 'player');
      try {
        const binding = await readJson(join(dir, 'player-verification.json')) as { caseHash: string; directory: string };
        if (binding.caseHash !== hash(c) || !/^[\w-]+$/.test(binding.directory)) throw new Error('重新试玩绑定来源无效');
        playerDir = join(dir, binding.directory);
        const source = await readJson(join(playerDir, 'provenance.json')) as { caseHash: string };
        if (source.caseHash !== hash(c)) throw new Error('重新试玩案件哈希不匹配');
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const playtest = await readJson(join(playerDir, 'playtest.json')) as BlindRecord & { reasoningMistakes: number };
      blindReproducible = blindTranscriptValid(c, playtest);
      blindDecisions = playtest.decisions.length; blindMistakes = playtest.reasoningMistakes;
      const originalPlaytest = await readJson(join(playerDir, 'playtest.json'));
      if (playerDir === join(acceptedDir, 'player')) blindReproducible &&= hash(originalPlaytest) === hash(await readJson(join(dir, 'playtest.json')));
      for (let n = 0; n < playtest.decisions.length; n++) {
        const call = join(playerDir, `decision-${n}`), decision = playtest.decisions[n]!;
        const prompt = await readFile(join(call, 'prompt.md'), 'utf8');
        const output = JSON.parse(await readFile(join(call, 'raw.json'), 'utf8'));
        const promptMatchesPublicInput = decision.input.view.inferences.some(x => prompt === playerPrompt(decision.input, x.id));
        blindReproducible &&= promptMatchesPublicInput && hash(output) === hash(decision.output);
      }
    }
    const passed = a.ok && freshReplay.ended && reviewAccepted(c, review) && provenance && reproducible && visiblePremises && blindReproducible && (legacy || c.version === '2.0');
    await saveJson(join(verificationDir, 'verification.json'), { ok: passed, caseHash: hash(c), provenance, reproducible, visiblePremises, publicViewMigrated, blindReproducible, audit: a });
    if (!passed) problems.push(`${entry.name} 重新验收失败`);
    if (manifest.kind === 'natural-generation') cases.push({ directory: entry.name, version: c.version, theme: c.theme, title: c.title, ok: passed, states: a.search?.states, probes: a.search?.probes, exhaustive: a.search?.exhaustive, steps: freshReplay.steps.length, blindDecisions, blindMistakes, acceptedAttempt: manifest.acceptedAttempt, caseHash: hash(c) });
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
      await saveJson(join(root, 'defects', item.name, legacy ? 'compatibility-v2.json' : 'verification.json'), checked);
    }
    mutation.ok = mutation.results.every(x => x.detected) &&
      mutation.results.some(x => x.expectedCode === 'reference') && mutation.results.some(x => x.expectedCode === 'unreachable-evidence');
  }
  if (!mutation?.ok) problems.push('缺少通过的故意破坏样例检验');
  const natural = experiments.filter(x => x.kind === 'natural-generation');
  const summary = {
    version: legacy ? 'compatibility-2.0' : 'acceptance-2.0', verifiedAt: new Date().toISOString(), ok: problems.length === 0, problems,
    naturalExperiments: natural.length, naturalAttempts: natural.reduce((n, x) => n + x.attempts.length, 0),
    firstAttemptAccepted: natural.filter(x => x.status === 'accepted' && x.acceptedAttempt === 0).length,
    repairedAccepted: natural.filter(x => x.status === 'accepted' && (x.acceptedAttempt ?? 0) > 0).length,
    failedExperiments: natural.filter(x => x.status === 'failed').length,
    validationFailedAttempts: natural.flatMap(x => x.attempts).filter(x => x.status === 'validation-failed').length,
    reviewFailedAttempts: natural.flatMap(x => x.attempts).filter(x => x.status === 'review-failed').length,
    additionalReviewFailedAttempts: natural.flatMap(x => x.attempts).filter(x => x.status === 'additional-review-failed').length,
    playerFailedAttempts: natural.flatMap(x => x.attempts).filter(x => x.status === 'player-failed').length,
    callOrParseFailedAttempts: natural.flatMap(x => x.attempts).filter(x => x.status === 'call-or-parse-failed').length,
    injectedRepairExperiments: experiments.filter(x => x.kind === 'injected-defect-repair').length,
    cases, experiments, mutation,
    limits: '自动汇总不能证明叙事/自然语言推理正确。独立 AI 评价与根 Agent 文本核对见 QUALITY_REPORT.md；三主题不代表广泛稳定性。',
  };
  await saveJson(join(root, legacy ? 'compatibility-v2.json' : 'acceptance.json'), summary);
  console.log(JSON.stringify({ ok: summary.ok, problems, cases, naturalAttempts: summary.naturalAttempts, failedExperiments: summary.failedExperiments }, null, 2)); return summary;
}
