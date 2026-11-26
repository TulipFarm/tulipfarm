import { z } from 'zod';
import { definitionGrantPredicate, type HumanActor, lockAndResolveHuman } from '@tulipfarm/access';
import { activeMemberProfiles } from './members.ts';
import { relation, type AgentTransaction } from './store.ts';

export const actorDirectorySchema = z.object({
  members: z.array(
    z.object({
      membershipId: z.uuid(),
      name: z.string(),
      email: z.string().nullable(),
      /** The member's Members table photo, an API path such as `/v1/workspaces/…/photos/…`. */
      photo: z.string().nullable(),
      /** Still a member; former members are left out, so this is always true. */
      current: z.boolean(),
    }),
  ),
  agents: z.array(z.object({ id: z.uuid(), name: z.string(), available: z.boolean() })),
});
export type ActorDirectory = z.infer<typeof actorDirectorySchema>;

/**
 * Everyone a row can be assigned to: the workspace's active members and its saved agents. An agent is available when
 * the reader may invoke it, since assigning starts a run on the assigner's behalf.
 */
export async function actorDirectory(tx: AgentTransaction, actor: HumanActor): Promise<ActorDirectory> {
  const members = await activeMemberProfiles(tx);
  const agents = z.array(z.object({ id: z.uuid(), name: z.string(), available: z.boolean() })).parse(
    (
      await tx.client.query(
        `SELECT a.id,a.display_name AS name,${definitionGrantPredicate(tx, 'agent', 'a.id', '$1::uuid', "'invoke'")} AS available
          FROM ${relation(tx, 'tf_agents')} a
          WHERE a.saved_revision IS NOT NULL AND a.deleted_at IS NULL AND a.enabled
          ORDER BY lower(a.display_name),a.id`,
        [actor.membershipId],
      )
    ).rows,
  );
  return {
    members: members.map(member => ({
      membershipId: member.membershipId,
      name: member.name,
      email: member.email,
      photo: member.photo,
      current: true,
    })),
    agents,
  };
}

export function createActorDirectory(runtime: {
  transaction<T>(
    workspaceId: string,
    compatibility: unknown,
    operation: (tx: AgentTransaction) => Promise<T>,
  ): Promise<T>;
}) {
  return {
    async read(workspaceId: string, userId: string, compatibility: unknown) {
      return runtime.transaction(z.uuid().parse(workspaceId), compatibility, async tx => {
        return actorDirectory(tx, await lockAndResolveHuman(tx, userId));
      });
    },
  };
}
