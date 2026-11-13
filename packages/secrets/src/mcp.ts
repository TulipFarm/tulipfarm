import { z } from 'zod';
import { authenticationHeaders, normalizeEndpoint } from '@tulipfarm/workspace-mcp-transport';
import { SecretError, type Placement, type SecretValue } from './contracts.ts';
import { table, type Secrets, type SecretTransaction } from './service.ts';

/** How an MCP connection names the saved secrets it authenticates with. */
export type McpSecretCredential =
  | { kind: 'secret-bearer'; secretId: string }
  | { kind: 'secret-headers'; secretIds: string[] };
export type McpSecretVersion = { secretId: string; version: number; policyVersion: number };
export type McpSecretUsers = { membershipIds: string[]; teamIds: string[] };
export type McpResolvedCredential =
  | { kind: 'bearer'; token: string }
  | { kind: 'headers'; headers: Record<string, string>; cookie?: string };

export const mcpSecretIds = (credential: McpSecretCredential) =>
  credential.kind === 'secret-bearer' ? [credential.secretId] : credential.secretIds;

function endpointOf(endpoint: string) {
  try {
    return normalizeEndpoint(endpoint);
  } catch {
    throw new SecretError('destination-denied');
  }
}

const single = (value: SecretValue | undefined) => (value && 'value' in value ? value.value : '');

/**
 * Builds what an MCP request sends from secrets in the order the credential names them. Without values it only
 * checks that the placements fit together: `secret-bearer` needs one bearer secret, and `secret-headers` takes
 * header, cookie and at most one bearer or basic secret, with no header named twice. Query and body placements
 * cannot reach an MCP server.
 */
export function mcpCredentialFrom(
  credential: McpSecretCredential,
  parts: ReadonlyArray<{ placement: Placement; value?: SecretValue }>,
): McpResolvedCredential {
  if (credential.kind === 'secret-bearer') {
    const [part] = parts;
    if (parts.length !== 1 || part!.placement.kind !== 'bearer') throw new SecretError('placement-unsupported');
    const token = part!.value ? single(part!.value) : 'placeholder';
    authenticationHeaders({ kind: 'bearer', token });
    return { kind: 'bearer', token };
  }
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  const claim = (name: string, value: string) => {
    const key = name.toLowerCase();
    if (key in headers) throw new SecretError('placement-unsupported');
    headers[key] = value;
  };
  for (const { placement, value } of parts) {
    switch (placement.kind) {
      case 'bearer':
        claim('authorization', `Bearer ${value ? single(value) : 'placeholder'}`);
        break;
      case 'basic': {
        const pair = !value
          ? 'placeholder:'
          : 'value' in value
            ? `${value.value}:`
            : `${value.username}:${value.password}`;
        claim('authorization', `Basic ${Buffer.from(pair).toString('base64')}`);
        break;
      }
      case 'header':
        claim(placement.name, value ? single(value) : 'placeholder');
        break;
      case 'cookie':
        if (cookies.some(cookie => cookie.startsWith(`${placement.name}=`)))
          throw new SecretError('placement-unsupported');
        cookies.push(`${placement.name}=${encodeURIComponent(value ? single(value) : 'placeholder')}`);
        break;
      default:
        throw new SecretError('placement-unsupported');
    }
  }
  const resolved = { kind: 'headers' as const, headers, ...(cookies.length ? { cookie: cookies.join('; ') } : {}) };
  try {
    authenticationHeaders(resolved);
  } catch {
    throw new SecretError('placement-unsupported');
  }
  return resolved;
}

const grantedTo = (tx: SecretTransaction, team: string) =>
  `EXISTS (SELECT 1 FROM ${table(tx, 'grants')} g WHERE g.secret_id = $1 AND g.role IN ('use','manage')
    AND (g.grantee = 'workspace' OR g.team_id = ${team}))`;

/**
 * Checks, without decrypting, that an MCP connection at `endpoint` may send these saved secrets for every member
 * and team that can use it. Each secret must be active and saved, name the exact endpoint (a host destination is
 * not enough) and be usable by each member. A team that can use the connection must hold its own grant, or the
 * workspace one, on each secret. Returns the versions in force now.
 */
export async function bindMcpSecrets(
  secrets: Secrets,
  tx: SecretTransaction,
  input: { credential: McpSecretCredential; endpoint: string; users: McpSecretUsers },
): Promise<McpSecretVersion[]> {
  const endpoint = endpointOf(input.endpoint);
  const ids = mcpSecretIds(input.credential);
  if (new Set(ids).size !== ids.length) throw new SecretError('invalid-input');
  const versions: McpSecretVersion[] = [];
  const parts: Array<{ placement: Placement }> = [];
  for (const id of ids) {
    const row = await secrets.internal.load(tx, id, 'share');
    if (row.lifetime !== 'saved') throw new SecretError('unavailable');
    const destinations = z
      .array(z.object({ kind: z.string(), value: z.string() }))
      .parse(
        (await tx.client.query(`SELECT kind, value FROM ${table(tx, 'destinations')} WHERE secret_id = $1`, [row.id]))
          .rows,
      );
    if (!destinations.some(destination => destination.kind === 'endpoint' && destination.value === endpoint))
      throw new SecretError('destination-denied');
    for (const membershipId of new Set(input.users.membershipIds)) {
      const rights = await secrets.internal.access(tx, membershipId, row);
      if (rights.status === 'expired') throw new SecretError('expired');
      if (rights.status !== 'active') throw new SecretError('unavailable');
      if (!rights.use) throw new SecretError('not-found');
    }
    for (const teamId of new Set(input.users.teamIds)) {
      const granted = z
        .object({ granted: z.boolean() })
        .parse(
          (await tx.client.query(`SELECT ${grantedTo(tx, '$2')} AS granted`, [row.id, z.uuid().parse(teamId)])).rows[0],
        );
      if (!granted.granted) throw new SecretError('not-found');
    }
    parts.push({ placement: row.placement });
    versions.push({ secretId: row.id, version: row.version, policyVersion: row.policy_version });
  }
  mcpCredentialFrom(input.credential, parts);
  return versions;
}

/** A saved secret a hosted MCP server's settings name, and whether the server may read its real value. */
export type McpHostedBinding = { name: string; secretId: string; reveal: boolean };
export type McpHostPlacement = { kind: 'bearer' } | { kind: 'basic' } | { kind: 'header'; name: string };
export type McpHostedSecret = McpSecretVersion & { hosts: string[]; placement: McpHostPlacement | null };

export function hostPlacement(placement: Placement): McpHostPlacement | null {
  if (placement.kind === 'bearer' || placement.kind === 'basic') return { kind: placement.kind };
  if (placement.kind === 'header') return { kind: 'header', name: placement.name };
  return null;
}

/**
 * Loads the destinations of a secret a hosted MCP server names and checks how it may use it. A protected secret
 * stays outside the server: the host adds it to requests for the secret's own hosts, so it needs a bearer, basic or
 * header placement and at least one host destination. A revealed one reaches the server as a plain value, which its
 * owner must have allowed for this server identity.
 */
export async function hostedSecretRow(
  secrets: Secrets,
  tx: SecretTransaction,
  secretId: string,
  uses: { protected: boolean; reveal: boolean },
  serverIdentity: string,
) {
  const row = await secrets.internal.load(tx, secretId, 'share');
  if (row.lifetime !== 'saved') throw new SecretError('unavailable');
  const hosts = z
    .array(z.object({ value: z.string() }))
    .parse(
      (
        await tx.client.query(
          `SELECT value FROM ${table(tx, 'destinations')} WHERE secret_id = $1 AND kind = 'host' ORDER BY value`,
          [row.id],
        )
      ).rows,
    )
    .map(({ value }) => value);
  const placement = hostPlacement(row.placement);
  if (uses.protected && (!placement || !hosts.length)) throw new SecretError('placement-unsupported');
  if (
    uses.reveal &&
    !(
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'reveals')} WHERE secret_id = $1 AND server_identity = $2 AND granted_by = $3`,
        [row.id, serverIdentity, row.owner_membership_id],
      )
    ).rowCount
  )
    throw new SecretError('destination-denied');
  return { row, hosts, placement };
}

export function hostedUses(bindings: readonly McpHostedBinding[]) {
  const uses = new Map<string, { protected: boolean; reveal: boolean }>();
  if (bindings.length > 20) throw new SecretError('invalid-input');
  for (const binding of bindings) {
    const use = uses.get(z.uuid().parse(binding.secretId)) ?? { protected: false, reveal: false };
    if (binding.reveal) use.reveal = true;
    else use.protected = true;
    uses.set(binding.secretId, use);
  }
  return uses;
}

/**
 * Checks, without decrypting, that a hosted MCP server may be given these saved secrets for every member and team
 * that can use it. Returns the versions in force now, with each secret's hosts and placement.
 */
export async function bindHostedMcpSecrets(
  secrets: Secrets,
  tx: SecretTransaction,
  input: { bindings: McpHostedBinding[]; serverIdentity: string; users: McpSecretUsers },
): Promise<McpHostedSecret[]> {
  const result: McpHostedSecret[] = [];
  for (const [secretId, uses] of hostedUses(input.bindings)) {
    const { row, hosts, placement } = await hostedSecretRow(secrets, tx, secretId, uses, input.serverIdentity);
    for (const membershipId of new Set(input.users.membershipIds)) {
      const rights = await secrets.internal.access(tx, membershipId, row);
      if (rights.status === 'expired') throw new SecretError('expired');
      if (rights.status !== 'active') throw new SecretError('unavailable');
      if (!rights.use) throw new SecretError('not-found');
    }
    for (const teamId of new Set(input.users.teamIds)) {
      const granted = z
        .object({ granted: z.boolean() })
        .parse(
          (await tx.client.query(`SELECT ${grantedTo(tx, '$2')} AS granted`, [row.id, z.uuid().parse(teamId)])).rows[0],
        );
      if (!granted.granted) throw new SecretError('not-found');
    }
    result.push({ secretId: row.id, version: row.version, policyVersion: row.policy_version, hosts, placement });
  }
  return result;
}
