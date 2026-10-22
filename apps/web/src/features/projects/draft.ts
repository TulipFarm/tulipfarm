import type { Project, ProjectEdit } from './api';

export type DraftField = 'name' | 'instructions';
export type ProjectText = Record<DraftField, string>;
export type SavedProject = Pick<Project, 'revision' | 'name' | 'instructions' | 'archived'>;
export type ProjectDraft = { base: SavedProject; values: ProjectText };

const fields: readonly DraftField[] = ['name', 'instructions'];
const sent = (field: DraftField, value: string) => (field === 'name' ? value.trim() : value);
const same = (field: DraftField, a: string, b: string) => sent(field, a) === sent(field, b);
const edited = (draft: ProjectDraft, field: DraftField) => !same(field, draft.values[field], draft.base[field]);
const saved = ({ revision, name, instructions, archived }: SavedProject): SavedProject => ({
  revision,
  name,
  instructions,
  archived,
});

export function startDraft(project: SavedProject): ProjectDraft {
  return { base: saved(project), values: { name: project.name, instructions: project.instructions } };
}

export function isDirty(draft: ProjectDraft) {
  return fields.some(field => edited(draft, field));
}

export function keepEdits(draft: ProjectDraft, latest: SavedProject): ProjectDraft {
  return {
    base: saved(latest),
    values: {
      name: edited(draft, 'name') ? draft.values.name : latest.name,
      instructions: edited(draft, 'instructions') ? draft.values.instructions : latest.instructions,
    },
  };
}

export function rebaseDraft(
  draft: ProjectDraft,
  latest: SavedProject,
): { draft: ProjectDraft; conflicts: DraftField[] } {
  if (latest.revision <= draft.base.revision) return { draft, conflicts: [] };
  const conflicts = fields.filter(
    field =>
      edited(draft, field) &&
      !same(field, latest[field], draft.base[field]) &&
      !same(field, latest[field], draft.values[field]),
  );
  if (!conflicts.length) return { draft: keepEdits(draft, latest), conflicts };
  const untouched = fields.filter(field => !edited(draft, field) && draft.values[field] !== latest[field]);
  if (!untouched.length) return { draft, conflicts };
  const follow = (text: ProjectText): ProjectText => ({
    name: untouched.includes('name') ? latest.name : text.name,
    instructions: untouched.includes('instructions') ? latest.instructions : text.instructions,
  });
  return { draft: { base: { ...draft.base, ...follow(draft.base) }, values: follow(draft.values) }, conflicts };
}

export function saveCommand(draft: ProjectDraft): ProjectEdit {
  return {
    expectedRevision: draft.base.revision,
    name: sent('name', draft.values.name),
    instructions: sent('instructions', draft.values.instructions),
    archived: draft.base.archived,
  };
}
