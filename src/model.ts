import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const text = z.string().min(1).max(6000);
const ids = z.array(id).max(40);
export const conditionSchema = z.object({
  knowledge: ids, evidence: ids, claims: ids, flags: ids,
}).strict();
export type Condition = z.infer<typeof conditionSchema>;
export const emptyCondition = (): Condition => ({ knowledge: [], evidence: [], claims: [], flags: [] });
const effectSchema = z.object({
  kind: z.enum(['knowledge', 'evidence', 'claim', 'flag']), id,
}).strict();

export const caseSchema = z.object({
  version: z.literal('1.0'), id, title: text, theme: text, prologue: text,
  characters: z.array(z.object({
    id, name: text, role: text, publicDescription: text,
    privateMotive: text, knowledgeFactIds: ids,
  }).strict()).min(2).max(6),
  locations: z.array(z.object({ id, name: text, description: text }).strict()).min(1).max(4),
  truth: z.object({
    culpritId: id, summary: text,
    facts: z.array(z.object({ id, text }).strict()).min(3).max(20),
    timeline: z.array(z.object({
      time: text, locationId: id, characterIds: ids, factIds: ids, text,
    }).strict()).min(2).max(12),
  }).strict(),
  knowledge: z.array(z.object({ id, text, factIds: ids }).strict()).min(3).max(16),
  evidence: z.array(z.object({
    id, name: text, description: text, source: text, reliability: text,
    limitations: text, knowledgeIds: ids,
  }).strict()).min(2).max(8),
  claims: z.array(z.object({
    id, characterId: id, text, truthStatus: z.enum(['truthful', 'lie', 'mistaken']),
    privateExplanation: text, factIds: ids,
  }).strict()).min(1).max(5),
  flags: ids,
  initial: z.object({ locationId: id, knowledge: ids, flags: ids }).strict(),
  actions: z.array(z.object({
    id, kind: z.enum(['inspect', 'talk', 'press']), label: text,
    locationId: id, targetKind: z.enum(['location', 'character', 'evidence']), targetId: id,
    requires: conditionSchema, effects: z.array(effectSchema).min(1).max(10),
    text, repeatText: text,
  }).strict()).min(4).max(12),
  inferences: z.array(z.object({
    id, label: text, locationId: id, claimId: id.nullable(),
    requires: conditionSchema, question: text,
    options: z.array(z.object({ id, text }).strict()).min(2).max(4),
    solutions: z.array(z.object({ optionId: id, evidenceIds: ids.min(1), knowledgeIds: ids.min(1) }).strict()).min(1).max(3),
    conclusionKnowledgeId: id, unlockFlags: ids,
    successText: text, failureText: text,
    argument: z.object({
      claim: text, relation: text,
      premises: z.array(z.object({ knowledgeId: id, quote: text }).strict()).min(1).max(8),
      alternatives: z.array(text).min(1).max(6), consequence: text,
    }).strict(),
  }).strict()).min(1).max(3),
  ending: z.object({ requires: conditionSchema, text }).strict(),
}).strict();

export type Case = z.infer<typeof caseSchema>;
export type State = {
  locationId: string; knowledge: string[]; evidence: string[]; claims: string[];
  flags: string[]; completed: string[]; solved: string[]; ended: boolean;
};
export type Command =
  | { kind: 'move'; id: string }
  | { kind: 'act'; id: string }
  | { kind: 'reason'; id: string; optionId: string; evidenceIds: string[] };
export type Result = { ok: boolean; status: string; state: State; text: string[] };
export const jsonSchema = z.toJSONSchema(caseSchema);
