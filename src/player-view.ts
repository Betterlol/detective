import type { Case, State } from './model.js';
import { orderedOptions, publicId } from './public.js';
import { activeClaim, satisfies } from './state-rules.js';

export function opening(c: Case): string[] {
  return [c.prologue, ...c.initial.knowledge.map(x => c.knowledge.find(k => k.id === x)!.text),
    c.locations.find(x => x.id === c.initial.locationId)!.description];
}

export function playerView(c: Case, s: State) {
  const handle = (kind: Parameters<typeof publicId>[1], id: string) => publicId(c, kind, id);
  return {
    title: c.title, ended: s.ended,
    location: { ...c.locations.find(x => x.id === s.locationId)!, id: handle('locations', s.locationId) },
    locations: c.locations.map(x => ({ id: handle('locations', x.id), name: x.name })),
    characters: c.characters.map(x => ({ id: handle('characters', x.id), name: x.name, role: x.role, description: x.publicDescription, mood: s.moods?.[x.id] || 'calm' })),
    knowledge: c.knowledge.filter(x => s.knowledge.includes(x.id)).map(x => ({ id: handle('knowledge', x.id), text: x.text })),
    evidence: c.evidence.filter(x => s.evidence.includes(x.id)).map(({ id, name, description, source, reliability, limitations }) => ({ id: handle('evidence', id), name, description, source, reliability, limitations })),
    claims: c.claims.filter(x => s.claims.includes(x.id)).map(({ id, characterId, text }) => ({ id: handle('claims', id), characterId: handle('characters', characterId), text, active: activeClaim(c, s, id), refuted: (s.refuted || []).includes(id) })),
    presses: c.version === '2.0' ? c.claims.filter(x => x.press && x.locationId === s.locationId && activeClaim(c, s, x.id) && satisfies(s, x.press.requires))
      .map(x => ({ id: handle('claims', x.id), text: x.text, completed: (s.pressed || []).includes(x.id) })) : [],
    actions: c.actions.filter(a => a.locationId === s.locationId && satisfies(s, a.requires))
      .map(a => ({ id: handle('actions', a.id), kind: a.kind, label: a.label, completed: s.completed.includes(a.id) })),
    inferences: c.inferences.filter(i => i.locationId === s.locationId && satisfies(s, i.requires) && (!i.claimId || activeClaim(c, s, i.claimId)))
      .map(i => ({ id: handle('inferences', i.id), label: i.label, question: i.question,
        claimId: i.claimId ? handle('claims', i.claimId) : null,
        options: orderedOptions(c, i).map(({ choice, text }) => ({ choice, text })), solved: s.solved.includes(i.id) })),
  };
}
