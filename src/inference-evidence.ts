import type { Case } from './model.js';
import { initialState } from './engine.js';
import { publicId } from './public.js';
import type { TraceStep } from './trace.js';

// Evidence sheet derived from execution, not from the reviewer's recollection of the trace.
export function inferenceEvidence(c: Case, trace: { steps: TraceStep[] }) {
  const acquired = (kind: 'knowledge' | 'evidence' | 'claims', id: string): number | null => {
    if (initialState(c)[kind].includes(id)) return 0;
    const n = trace.steps.findIndex(s => !s.before[kind].includes(id) && s.after[kind].includes(id));
    return n < 0 ? null : n + 1;
  };
  return trace.steps.flatMap((step, n) => {
    if (step.command.kind !== 'reason' && step.command.kind !== 'present') return [];
    const i = c.inferences.find(x => x.id === step.command.id)!;
    const command = step.command;
    const solution = i.solutions.find(x => x.optionId === command.optionId && x.evidenceIds.every(e => command.evidenceIds.includes(e)))!;
    return [{ inferenceId: i.id, executedAt: n + 1, question: i.question,
      claim: i.claimId ? { ...step.playerBefore.claims.find(x => x.id === publicId(c, 'claims', i.claimId!)), acquiredAt: acquired('claims', i.claimId) } : null,
      submittedArgument: i.options.find(x => x.id === command.optionId)!.text,
      evidence: command.evidenceIds.map(id => ({ ...step.playerBefore.evidence.find(x => x.id === publicId(c, 'evidence', id)), acquiredAt: acquired('evidence', id) })),
      prerequisites: solution.knowledgeIds.map(id => ({ id, text: step.playerBefore.knowledge.find(x => x.id === publicId(c, 'knowledge', id))?.text,
        acquiredAt: acquired('knowledge', id), presentBeforeReasoning: step.before.knowledge.includes(id) })),
      premises: i.argument.premises.map(p => ({ ...p, acquiredAt: acquired('knowledge', p.knowledgeId),
        visibleBeforeReasoning: !!step.playerBefore.knowledge.find(k => k.id === publicId(c, 'knowledge', p.knowledgeId))?.text.includes(p.quote) })),
      progressionText: step.text, authorRelation: i.argument.relation,
      limit: '只证明这些文字在执行时已呈现与条件满足，论证蕴含关系仍须文本审查。',
    }];
  });
}
