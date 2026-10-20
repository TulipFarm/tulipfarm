import { z } from 'zod';
import { githubInvestigationPermissionSchema } from './github-investigation.ts';

export const uuidSchema = z.uuid().transform(value => value.toLowerCase());
export const humanActorSchema = z.strictObject({
  kind: z.literal('human'),
  userId: z.string().min(1),
  membershipId: uuidSchema,
});
export type HumanActor = z.infer<typeof humanActorSchema>;
export const actorSchema = z.discriminatedUnion('kind', [
  humanActorSchema,
  z.strictObject({ kind: z.literal('agent'), runId: uuidSchema }),
]);
export type Actor = z.infer<typeof actorSchema>;
export const tablePermissionSchema = z.enum([
  'table.schema.manage',
  'table.row.create',
  'table.row.read',
  'table.row.update',
  'table.row.delete',
  'table.create',
]);
export type TablePermission = z.infer<typeof tablePermissionSchema>;
export const integrationPermissionSchema = z.enum([
  'integration.read',
  'integration.use',
  'integration.manage',
  'integration.create',
  'github.issue.read',
  ...githubInvestigationPermissionSchema.options,
]);
export const slackPermissionSchema = z.enum(['slack.message.send', 'slack.thread.reply', 'slack.reaction.add']);
export const assetPermissionSchema = z.union([
  tablePermissionSchema,
  integrationPermissionSchema,
  slackPermissionSchema,
]);
export type AssetPermission = z.infer<typeof assetPermissionSchema>;
