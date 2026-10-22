import { AccessDenied } from '@tulipfarm/access';
import type { ChatSkills } from '@tulipfarm/conversations/skill-invocations';
import { skillIdSchema } from './skills.ts';
import { procedureSelectionSchema } from './workspace-skill-contracts.ts';
import { resolveProcedures } from './workspace-skills.ts';

export const chatSkills: ChatSkills = {
  async resolve(tx, actor, invocation) {
    const selection = procedureSelectionSchema.safeParse({ id: invocation.skillId, revision: invocation.revision });
    if (!selection.success) return null;
    try {
      return (
        (await resolveProcedures(tx, [selection.data], actor)).map(procedure => {
          const description = procedure.package?.manifest.metadata.description ?? procedure.description;
          return {
            skillId: procedure.id,
            revision: procedure.revision,
            name: procedure.name,
            ...(description === undefined ? {} : { description }),
            instructions: procedure.instructions,
            origin: skillIdSchema.safeParse(procedure.id).success ? ('built-in' as const) : ('workspace' as const),
          };
        })[0] ?? null
      );
    } catch (error) {
      if (error instanceof AccessDenied) return null;
      throw error;
    }
  },
};
