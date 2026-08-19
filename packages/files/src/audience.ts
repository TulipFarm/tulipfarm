import { BUSINESS_PRINCIPAL_ID } from "./limits";
import type { FileGrantee } from "./repo";

/** The Roles a Principal holds, as the grantees a share is written against. */
export function roleGrantees(roleIds: readonly string[]): readonly FileGrantee[] {
  return roleIds.map((id) => ({ kind: "role", id }) as const);
}

/**
 * Who may read a File the moment an Agent finishes writing it.
 *
 * The requester, plus every Role the authoring Agent holds. That second half is what lets an Agent
 * working for a team produce something the team can open: an HR Agent's report readable only by
 * whoever happened to trigger the Run is one every other HR person has to ask for by hand, and the
 * asking is the part that does not happen.
 *
 * The Agent's Roles are the ones its own Principal holds, so the audience widens only where an
 * admin deliberately assigned one. Nothing here is reachable from the model's arguments — the Tool
 * schema cannot name an audience — and it is strictly an audience: it says who may read what the
 * Agent wrote and grants the Agent itself no reach at all. An Agent holding no Role behaves
 * exactly as it did before.
 *
 * The requester's own share is added to rather than replaced, because losing access to a document
 * you asked for, the moment the Agent joins a team, is the opposite of the point.
 */
export async function generatedAudience(
  request: {
    readonly businessId: string;
    readonly readableBy?: FileGrantee;
    readonly authoredByAgentId?: string;
  },
  rolesOf?: (businessId: string, principalId: string) => Promise<readonly string[]>
): Promise<readonly FileGrantee[]> {
  const candidates: FileGrantee[] = [];
  if (request.readableBy !== undefined) candidates.push(request.readableBy);
  if (request.authoredByAgentId !== undefined) {
    const held = await rolesOf?.(request.businessId, request.authoredByAgentId);
    candidates.push(...roleGrantees(held ?? []));
  }

  const seen = new Set<string>();
  const audience: FileGrantee[] = [];
  for (const grantee of candidates) {
    // The business already owns a generated File, so a share to it is a row that grants nothing.
    if (grantee.kind === "user" && grantee.id === BUSINESS_PRINCIPAL_ID) continue;
    const key = `${grantee.kind}:${grantee.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    audience.push(grantee);
  }
  return audience;
}
