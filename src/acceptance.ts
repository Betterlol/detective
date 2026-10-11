import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Case } from './model.js';
import { audit } from './validate.js';
import { hash, readJson, saveJson } from './io.js';
import { verifyAcceptedExperiment, type AcceptedCaseSummary, type AcceptanceManifest } from './experiment-verification.js';
import { defaultDetectiveConfig } from './config.js';

type MutationReport = { ok: boolean; sourceCaseHash: string; results: { name: string; expectedCode: string; detected: boolean }[] };

export async function mutationChecks(c: Case, dir: string, limit = defaultDetectiveConfig.validation.searchStateLimit) {
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
    const started = Date.now(), report = audit(copy, limit), detected = report.issues.some(i => i.code === t.code);
    await saveJson(join(dir, t.name, 'case.json'), copy); await saveJson(join(dir, t.name, 'audit.json'), report);
    results.push({ name: t.name, expectedCode: t.code, detected, issues: report.issues,
      auditMetrics: { elapsedMs: Date.now() - started, searchCount: report.search ? 1 : 0 } });
  }
  const result = { kind: 'injected-mutations-not-natural-failures', sourceCaseHash: hash(c), ok: results.every(x => x.detected), results };
  await saveJson(join(dir, 'mutations.json'), result); console.log(`缺陷检验 ${results.filter(x => x.detected).length}/${results.length}`); return result;
}

export async function acceptance(root: string, legacy = false, limit = defaultDetectiveConfig.validation.searchStateLimit) {
  const cases: AcceptedCaseSummary[] = [], experiments = [], problems: string[] = [];
  let repaired = false;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let manifest: AcceptanceManifest;
    try { manifest = await readJson(join(dir, 'manifest.json')) as typeof manifest; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    experiments.push({ directory: entry.name, ...manifest });
    if (manifest.status !== 'accepted' || manifest.acceptedAttempt === null) continue;
    const verification = await verifyAcceptedExperiment(dir, entry.name, manifest, legacy, limit);
    if (verification.problem) problems.push(verification.problem);
    if (verification.caseSummary) cases.push(verification.caseSummary);
    if (verification.repaired) repaired = true;
  }
  if (cases.filter(x => x.ok).length < 3) problems.push('少于3个真实生成且重新通过验收的主题案件');
  if (new Set(cases.filter(x => x.ok).map(x => x.theme)).size < 3) problems.push('主题数不足3；文字不同的实质差异另见质量报告');
  if (!repaired) problems.push('缺少实际模型反馈修复成功记录');
  let mutation: MutationReport | null = null;
  try { mutation = await readJson(join(root, 'defects', 'mutations.json')) as MutationReport; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (mutation) {
    for (const item of mutation.results) {
      const checked = audit(await readJson(join(root, 'defects', item.name, 'case.json')), limit);
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
