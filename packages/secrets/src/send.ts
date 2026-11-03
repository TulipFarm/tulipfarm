import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  SecretError,
  destinationAllows,
  originSchema,
  sameOrigin,
  type Destination,
  type Placement,
  type SecretKind,
  type SecretOrigin,
  type SecretValue,
} from './contracts.ts';
import { redactUrl } from './placement.ts';
import { table, type Secrets, type SecretTransaction } from './service.ts';

export type SecretHandle =
  | { kind: 'reference'; referenceId: string; origin: SecretOrigin }
  | { kind: 'secret'; secretId: string; origin?: SecretOrigin };

export type ResolveInput = {
  workspaceId: string;
  membershipId: string;
  secret: SecretHandle;
  /** The full request URL, without any `query` placement value. */
  url: string;
  expected?: { version: number; policyVersion: number };
};

export type ResolvedSecret = {
  secretId: string;
  version: number;
  policyVersion: number;
  kind: SecretKind;
  placement: Placement;
  destinations: Destination[];
  value: SecretValue;
};

/**
 * Checks that a member may send a secret to `url` now and decrypts it, inside the consumer's send or claim
 * transaction. The share lock makes a replacement that commits first fail this call (P26). Only the worker
 * may import this module.
 */
export async function resolveForSend(
  secrets: Secrets,
  tx: SecretTransaction,
  input: ResolveInput,
): Promise<ResolvedSecret> {
  const membershipId = z.uuid().parse(input.membershipId);
  const member = await tx.client.query(
    `SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} WHERE id = $1 AND removed_at IS NULL`,
    [membershipId],
  );
  if (!member.rowCount) throw new AccessDenied();
  let secretId: string;
  const origin = input.secret.origin ? originSchema.parse(input.secret.origin) : undefined;
  if (input.secret.kind === 'reference') {
    const reference = z
      .object({ secret_id: z.uuid(), membership_id: z.uuid(), origin: originSchema })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT secret_id, membership_id, origin FROM ${table(tx, 'references')} WHERE id = $1`,
            [z.uuid().parse(input.secret.referenceId)],
          )
        ).rows[0],
      );
    // A reference works only for its member, in the chat or task run it was given in (P14).
    if (!reference || reference.membership_id !== membershipId || !sameOrigin(reference.origin, origin!))
      throw new AccessDenied();
    secretId = reference.secret_id;
  } else secretId = z.uuid().parse(input.secret.secretId);

  const row = await secrets.internal.load(tx, secretId, 'share');
  if (row.lifetime === 'conversation' && (!origin || !row.origin || !sameOrigin(row.origin, origin)))
    throw new AccessDenied();
  const rights = await secrets.internal.access(tx, membershipId, row);
  if (rights.status === 'expired') throw new SecretError('expired');
  if (rights.status !== 'active') throw new SecretError('unavailable');
  if (!rights.use) throw new AccessDenied();
  const destinations = z
    .array(z.object({ kind: z.enum(['host', 'endpoint']), value: z.string() }))
    .parse(
      (await tx.client.query(`SELECT kind, value FROM ${table(tx, 'destinations')} WHERE secret_id = $1`, [row.id]))
        .rows,
    );
  if (!destinationAllows(destinations, redactUrl(input.url, [row.placement])))
    throw new SecretError('destination-denied');
  if (input.expected && (input.expected.version !== row.version || input.expected.policyVersion !== row.policy_version))
    throw new SecretError('conflict');
  const value = secrets.internal.cipher.decrypt(
    { workspaceId: input.workspaceId, secretId: row.id, version: row.version, placement: row.placement },
    row.kind,
    row.credential,
  );
  return {
    secretId: row.id,
    version: row.version,
    policyVersion: row.policy_version,
    kind: row.kind,
    placement: row.placement,
    destinations,
    value,
  };
}

/** Records a use without the value: tool, redacted destination URL and origin (P32). */
export async function recordUse(
  secrets: Secrets,
  tx: SecretTransaction,
  input: { secretId: string; membershipId: string; tool: string; url: string; origin?: SecretOrigin },
) {
  const row = await secrets.internal.load(tx, input.secretId, 'none');
  await tx.client.query(`UPDATE ${table(tx, 'secrets')} SET last_used_at = clock_timestamp() WHERE id = $1`, [row.id]);
  await secrets.internal.event(tx, row.id, input.membershipId, 'used', {
    tool: input.tool,
    url: redactUrl(input.url, [row.placement]),
    origin: input.origin ?? null,
  });
}
