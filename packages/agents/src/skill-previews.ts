import { AccessDenied, currentMember, lockAuthorization, resolveHuman, uuidSchema } from '@tulipfarm/access';
import type { FileBytes } from '@tulipfarm/files';
import { createWorkspaceSkills } from './workspace-skills.ts';
import { createSkillImports } from './skill-imports.ts';
import { createSkillObjects, skillPackageCompatibility } from './skill-objects.ts';
import { skillPreviewQuerySchema, skillPreviewSchema } from './skill-import-contracts.ts';
import type { AgentStorage } from './store.ts';
import type { SkillPackage } from './skill-package-contracts.ts';

export function createSkillPreviews(runtime: AgentStorage, bytes: FileBytes) {
  const objects = createSkillObjects(runtime, bytes),
    imports = createSkillImports(runtime);
  async function preview(workspaceId: string, value: unknown, authorize: () => Promise<SkillPackage>) {
    const query = skillPreviewQuerySchema.parse(value);
    const pkg = await authorize();
    const content = await objects.readFile(workspaceId, pkg, query.path);
    await authorize();
    let text: string | null;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      text = null;
    }
    if (text?.includes('\0')) text = null;
    return skillPreviewSchema.parse({
      path: query.path,
      kind: text === null ? 'binary' : 'text',
      size: content.byteLength,
      text: text?.slice(query.offset, query.offset + 16000) ?? null,
      nextOffset: text !== null && query.offset + 16000 < text.length ? query.offset + 16000 : null,
    });
  }
  return {
    installed(workspaceId: string, user: string, skillId: string, revision: string, value: unknown) {
      return preview(workspaceId, value, async () => {
        const actor = await runtime.transaction(workspaceId, skillPackageCompatibility, async tx => {
          await lockAuthorization(tx);
          const actor = await resolveHuman(tx, user);
          await currentMember(tx, actor);
          return actor;
        });
        const skill = await createWorkspaceSkills(runtime).read(workspaceId, actor, uuidSchema.parse(skillId));
        if (skill.revision !== revision || !skill.definition.package) throw new AccessDenied();
        return skill.definition.package;
      });
    },
    imported(workspaceId: string, user: string, importId: string, candidateId: string, value: unknown) {
      return preview(workspaceId, value, async () => {
        const view = await imports.read(workspaceId, user, importId);
        const candidate = view.candidates.find(candidate => candidate.id === candidateId);
        if (['expired', 'cancelled', 'failed'].includes(view.status) || !candidate?.definition.package)
          throw new AccessDenied();
        return candidate.definition.package;
      });
    },
  };
}
