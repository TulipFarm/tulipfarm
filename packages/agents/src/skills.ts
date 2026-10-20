import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { z } from 'zod';
import { builtinSkillRevision, skillIdSchema, type skillSelectionsSchema } from './skill-ids.ts';

export { skillIdSchema, skillSelectionSchema, skillSelectionsSchema } from './skill-ids.ts';

// Resolves from both src/ and dist/.
const root = new URL('../skills/', import.meta.url);

function loadSkill(id: z.infer<typeof skillIdSchema>) {
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(readFileSync(new URL(`${id}/SKILL.md`, root), 'utf8'));
  if (!match) throw new Error(`Invalid built-in skill ${id}`);
  const meta = new Map(
    match[1]!.split('\n').map(line => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]),
  );
  const name = meta.get('title'),
    description = meta.get('description');
  if (meta.get('name') !== id || !name || !description) throw new Error(`Invalid built-in skill ${id}`);
  const references = new URL(`${id}/references/`, root);
  const resources = existsSync(references)
    ? Object.fromEntries(
        readdirSync(references)
          .sort()
          .map(file => [`references/${file}`, readFileSync(new URL(file, references), 'utf8')]),
      )
    : {};
  return {
    skill: { id, revision: builtinSkillRevision, name, description, instructions: match[2]!.trimEnd() },
    resources,
  };
}

const loaded = skillIdSchema.options.map(loadSkill);
export const skills = loaded.map(({ skill }) => skill);
const resourcesById = new Map(loaded.map(({ skill, resources }) => [skill.id, resources]));

export function resolveSelectedSkills(selections: z.infer<typeof skillSelectionsSchema> = []) {
  return selections.map(selection => ({
    ...skills.find(skill => skill.id === selection.id)!,
    revision: selection.revision,
  }));
}

export function listSkills(context: 'chat' | 'agent' = 'agent') {
  return {
    skills: skills
      .filter(skill => context === 'chat' || skill.id !== 'planning')
      .map(({ id, revision, name, description }) => ({ id, revision, name, description })),
    source: 'bundled' as const,
  };
}
export function readSkill(id: string, _revision?: string, resource?: string, context: 'chat' | 'agent' = 'agent') {
  if (id === 'planning' && context !== 'chat') return undefined;
  const skill = skills.find(skill => skill.id === id);
  const resources = resourcesById.get(skill?.id as z.infer<typeof skillIdSchema>) ?? {};
  if (resource !== undefined && !(resource in resources)) throw new Error('skill-resource-unavailable');
  if (!skill || Object.keys(resources).length === 0) return skill;
  return {
    ...skill,
    resources: Object.entries(resources).map(([path, text]) => ({
      path,
      digest: createHash('sha256').update(text).digest('hex'),
    })),
    ...(resource ? { resource: { path: resource, text: resources[resource]! } } : {}),
  };
}
