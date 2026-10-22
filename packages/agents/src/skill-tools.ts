import { z } from 'zod';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import type { SkillImportView } from './skill-import-contracts.ts';
import type { HumanActor, SourceDependency } from '@tulipfarm/access';
import { AccessDenied } from '@tulipfarm/access';
import type { FileBytes } from '@tulipfarm/files';
import type { AgentStorage } from './store.ts';
import { createWorkspaceSkills } from './workspace-skills.ts';
import { createSkillObjects } from './skill-objects.ts';
import { createSkillImports } from './skill-imports.ts';
import {
  skillPackageLimits,
  skillPackageSchema,
  skillPathSchema,
  SkillPackageError,
} from './skill-package-contracts.ts';
import { workspaceSkillDefinitionSchema } from './workspace-skill-contracts.ts';
import type { SkillPackageFile } from './skill-packages.ts';

export const skillDraftInputSchema = z
  .strictObject({
    expectedVersion: z.number().int().nonnegative(),
    definition: workspaceSkillDefinitionSchema.omit({ package: true }).optional(),
    files: z
      .array(
        z.strictObject({
          path: skillPathSchema,
          content: z.string().max(1048576).nullable(),
          encoding: z.enum(['utf8', 'base64']).default('utf8'),
        }),
      )
      .min(1)
      .max(skillPackageLimits.files)
      .optional(),
  })
  .refine(
    input => (input.definition === undefined) !== (input.files === undefined),
    'Supply package file changes or a legacy procedure, not both',
  );

export function createSkillTools(runtime: AgentStorage, bytes?: Pick<FileBytes, 'putIfAbsent' | 'read'>) {
  const skills = createWorkspaceSkills(runtime),
    imports = createSkillImports(runtime);
  const objects = bytes ? createSkillObjects(runtime, bytes) : null;
  const draftReceipt = (view: SkillImportView) => ({
    importId: view.id,
    status: view.status,
    receipts: view.receipts,
    instruction:
      view.status === 'installed'
        ? 'The exact package was installed by the human. Use the saved receipts; do not prepare it again.'
        : 'Open this existing package review for its current state and warnings. AI review uses normal Credits. Only the human can install and enable it; chat text is not approval.',
  });
  async function draft(
    workspaceId: string,
    actor: HumanActor,
    id: string,
    skillId: string,
    input: z.infer<typeof skillDraftInputSchema>,
    origin: readonly SourceDependency[],
  ) {
    if (!objects) throw new SkillPackageError('package-unavailable');
    const requestDigest = createHash('sha256').update(canonicalJson({ skillId, input, origin })).digest('hex');
    const replay = await imports.replayDraft(workspaceId, actor, id, requestDigest);
    if (replay) return draftReceipt(replay);
    let files: SkillPackageFile[] = [];
    let target: { id: string; expectedVersion: number } | undefined;
    if (input.expectedVersion > 0) {
      if (skillId === 'new') throw new SkillPackageError('import-conflict');
      const detail = await skills.read(workspaceId, actor, skillId);
      if (!detail.management || detail.management.version !== input.expectedVersion)
        throw new SkillPackageError('import-conflict');
      target = { id: skillId, expectedVersion: input.expectedVersion };
      if (detail.definition.package) files = await objects.readFiles(workspaceId, detail.definition.package);
      const current = await skills.read(workspaceId, actor, skillId);
      if (!current.management || current.management.version !== input.expectedVersion)
        throw new SkillPackageError('import-conflict');
    }
    if (input.definition) {
      if ('package' in input.definition) throw new SkillPackageError('invalid-package');
      const name = input.definition.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 64)
        .replace(/-$/, '');
      files = [
        ...files.filter(file => file.path !== 'SKILL.md'),
        {
          path: 'SKILL.md',
          bytes: Buffer.from(
            `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(input.definition.description ?? input.definition.name)}\n---\n${input.definition.instructions}\n`,
          ),
        },
      ];
    } else {
      const map = new Map(files.map(file => [file.path, file]));
      const changed = new Set<string>();
      for (const change of input.files ?? []) {
        if (changed.has(change.path)) throw new SkillPackageError('invalid-package');
        changed.add(change.path);
        if (change.content === null) map.delete(change.path);
        else {
          const content = Buffer.from(change.content, change.encoding);
          if (change.encoding === 'base64' && content.toString('base64') !== change.content)
            throw new SkillPackageError('invalid-package');
          map.set(change.path, { path: change.path, bytes: content });
        }
      }
      files = [...map.values()];
    }
    const view = await imports.draft(workspaceId, actor, id, files, origin, objects, target, requestDigest);
    return draftReceipt(view);
  }
  async function readFile(
    workspaceId: string,
    actor: HumanActor,
    skillId: string,
    revision: string,
    path: string,
    offset = 0,
  ) {
    if (!objects) throw new SkillPackageError('package-unavailable');
    const [skill] = await skills.resolve(workspaceId, actor, [{ id: skillId, revision }]);
    if (!skill || !('package' in skill) || !skill.package) throw new AccessDenied();
    const bytes = await objects.readFile(workspaceId, skillPackageSchema.parse(skill.package), path);
    await skills.resolve(workspaceId, actor, [{ id: skillId, revision }]);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return {
        skillId,
        revision,
        path,
        kind: 'binary',
        size: bytes.byteLength,
        instruction: 'This is a binary asset, not text. Use it only through the isolated script runtime.',
      };
    }
    if (text.includes('\0')) return { skillId, revision, path, kind: 'binary', size: bytes.byteLength };
    return {
      skillId,
      revision,
      path,
      kind: 'text',
      text: text.slice(offset, offset + 16000),
      nextOffset: offset + 16000 < text.length ? offset + 16000 : null,
    };
  }
  return { draft, readFile };
}
