import type { Client } from 'pg';
import { z } from 'zod';
import { qualified } from '@tulipfarm/workspace-storage/runtime';

export const memberIdentitiesVersion = 120;

export const hasMemberIdentities = (tx: object) =>
  ((tx as { commonVersion?: number }).commonVersion ?? 0) >= memberIdentitiesVersion;

export type IdentityTransaction = { client: Pick<Client, 'query'>; schema: string; commonVersion?: number };

type IdentityAddress = { externalId: string | null; handle: string | null };

type IdentityProvider = {
  label: string;
  defaultScope: string | null;
  handlePrefix: '@' | null;
  supportsManual: boolean;
  mention: (identity: IdentityAddress) => string | null;
  profileUrl: (identity: IdentityAddress) => string | null;
};

const at = (handle: string | null) => (handle ? `@${handle}` : null);
const userMention = (identity: IdentityAddress) =>
  identity.externalId ? `<@${identity.externalId}>` : at(identity.handle);
const profileAt = (base: string) => (identity: IdentityAddress) =>
  identity.handle ? base + encodeURIComponent(identity.handle) : null;
const noProfile = () => null;

export const identityProviders = {
  github: {
    label: 'GitHub',
    defaultScope: 'github.com',
    handlePrefix: '@',
    supportsManual: true,
    mention: identity => at(identity.handle),
    profileUrl: profileAt('https://github.com/'),
  },
  slack: {
    label: 'Slack',
    // Slack users live in one workspace, so the scope is the installed team ID rather than a fixed host.
    defaultScope: null,
    handlePrefix: '@',
    supportsManual: true,
    mention: userMention,
    profileUrl: noProfile,
  },
  google: {
    label: 'Google',
    defaultScope: 'accounts.google.com',
    handlePrefix: null,
    supportsManual: false,
    mention: identity => identity.handle ?? null,
    profileUrl: noProfile,
  },
  atlassian: {
    label: 'Atlassian',
    defaultScope: 'atlassian.com',
    handlePrefix: null,
    supportsManual: true,
    mention: identity => at(identity.handle),
    profileUrl: noProfile,
  },
  trello: {
    label: 'Trello',
    defaultScope: 'trello.com',
    handlePrefix: '@',
    supportsManual: true,
    mention: identity => at(identity.handle),
    profileUrl: profileAt('https://trello.com/'),
  },
  discord: {
    label: 'Discord',
    defaultScope: 'discord.com',
    handlePrefix: '@',
    supportsManual: true,
    mention: userMention,
    profileUrl: noProfile,
  },
  telegram: {
    label: 'Telegram',
    defaultScope: 'telegram.org',
    handlePrefix: '@',
    supportsManual: true,
    mention: identity => at(identity.handle),
    profileUrl: profileAt('https://t.me/'),
  },
  teams: {
    label: 'Microsoft Teams',
    defaultScope: 'teams.microsoft.com',
    handlePrefix: null,
    supportsManual: true,
    mention: identity => at(identity.handle),
    profileUrl: noProfile,
  },
  linear: {
    label: 'Linear',
    defaultScope: 'linear.app',
    handlePrefix: '@',
    supportsManual: true,
    mention: identity => at(identity.handle),
    profileUrl: noProfile,
  },
  x: {
    label: 'X',
    defaultScope: 'x.com',
    handlePrefix: '@',
    supportsManual: true,
    mention: identity => at(identity.handle),
    profileUrl: profileAt('https://x.com/'),
  },
  linkedin: {
    label: 'LinkedIn',
    defaultScope: 'linkedin.com',
    handlePrefix: null,
    supportsManual: true,
    mention: noProfile,
    profileUrl: profileAt('https://www.linkedin.com/in/'),
  },
} as const satisfies Record<string, IdentityProvider>;

export type KnownIdentityProvider = keyof typeof identityProviders;

export const identityProviderList = Object.entries(identityProviders).map(
  ([id, { label, defaultScope, handlePrefix, supportsManual }]) => ({
    id,
    label,
    defaultScope,
    handlePrefix,
    supportsManual,
  }),
);

// These mirror the CHECK constraints in 0120_member_identities.sql, so bad input fails here with a typed error.
const providerPattern = /^[a-z][a-z0-9-]{0,31}$/;
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const handlePattern = /^[^\s@\p{Cc}][^\s\p{Cc}]{0,127}$/u;
const externalIdPattern = /^[\x21-\x7e]{1,128}$/;
const controlPattern = /\p{Cc}/u;

const errorStatus = {
  'provider-invalid': 400,
  'scope-invalid': 400,
  'handle-invalid': 400,
  'external-id-invalid': 400,
  'display-name-invalid': 400,
  'manual-not-allowed': 400,
  'identity-incomplete': 400,
  'identity-claimed': 409,
  'identity-not-found': 404,
  'member-not-found': 404,
  unsupported: 503,
} as const;

export type MemberIdentityErrorCode = keyof typeof errorStatus;

export class MemberIdentityError extends Error {
  readonly code: MemberIdentityErrorCode;
  readonly status: (typeof errorStatus)[MemberIdentityErrorCode];
  constructor(code: MemberIdentityErrorCode) {
    super(`Member identity ${code}`);
    this.code = code;
    this.status = errorStatus[code];
  }
}

function identityProvider(provider: string): IdentityProvider {
  if (Object.hasOwn(identityProviders, provider)) return identityProviders[provider as KnownIdentityProvider];
  return {
    label: provider
      .split('-')
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' '),
    defaultScope: provider,
    handlePrefix: null,
    supportsManual: true,
    mention: identity => identity.handle ?? null,
    profileUrl: noProfile,
  };
}

export function normalizeExternalProvider(raw: string): string {
  const provider = raw.trim().toLowerCase();
  if (!providerPattern.test(provider)) throw new MemberIdentityError('provider-invalid');
  return provider;
}

export function normalizeExternalScope(provider: string, raw?: string | null, workspaceScope?: string | null): string {
  const scope = raw?.trim() || identityProvider(provider).defaultScope || workspaceScope?.trim() || provider;
  if (!scopePattern.test(scope)) throw new MemberIdentityError('scope-invalid');
  return scope;
}

export function normalizeExternalHandle(provider: string, raw: string): string {
  normalizeExternalProvider(provider);
  const trimmed = raw.trim();
  const handle = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (!handlePattern.test(handle)) throw new MemberIdentityError('handle-invalid');
  return handle;
}

export function normalizeExternalId(raw: string): string {
  const externalId = raw.trim();
  if (!externalIdPattern.test(externalId)) throw new MemberIdentityError('external-id-invalid');
  return externalId;
}

function normalizeDisplayName(raw: string): string {
  const name = raw.trim();
  if ([...name].length > 200 || controlPattern.test(name)) throw new MemberIdentityError('display-name-invalid');
  return name;
}

export const formatExternalMention = (identity: IdentityAddress & { provider: string }) =>
  identityProvider(identity.provider).mention(identity);

export const externalProfileUrl = (identity: IdentityAddress & { provider: string }) =>
  identityProvider(identity.provider).profileUrl(identity);

export const memberIdentityTrustSchema = z.enum(['verified', 'manual']);
export type MemberIdentityTrust = z.infer<typeof memberIdentityTrustSchema>;

export const memberIdentitySchema = z.object({
  id: z.uuid().nullable(),
  memberId: z.uuid(),
  membershipId: z.uuid().nullable(),
  provider: z.string(),
  providerLabel: z.string(),
  scope: z.string(),
  externalId: z.string().nullable(),
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  aliases: z.array(z.string()),
  trust: memberIdentityTrustSchema,
  conflict: z.enum(['verified-elsewhere']).nullable(),
  profileUrl: z.string().nullable(),
  mention: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type MemberIdentity = z.infer<typeof memberIdentitySchema>;

export type IdentityMatch = {
  memberId: string;
  membershipId: string | null;
  trust: MemberIdentityTrust;
  via: 'external-id' | 'handle' | 'alias';
  externalId: string | null;
  handle: string | null;
};

export type IdentityResolution = {
  key: { kind: 'external-id' | 'handle'; value: string };
  status: 'resolved' | 'ambiguous' | 'unresolved';
  memberId: string | null;
  membershipId: string | null;
  trust: MemberIdentityTrust | null;
  hits: IdentityMatch[];
};

const relations = (tx: IdentityTransaction) => ({
  links: qualified(tx.schema, 'tf_member_verified_links'),
  handles: qualified(tx.schema, 'tf_member_external_handles'),
  observations: qualified(tx.schema, 'tf_member_external_handle_observations'),
  identities: qualified(tx.schema, 'tf_table_identities'),
  accounts: qualified(tx.schema, 'tf_workspace_member_accounts'),
  memberships: qualified(tx.schema, 'tf_memberships'),
  systemTables: qualified(tx.schema, 'tf_system_tables'),
  slackInstallations: qualified(tx.schema, 'tf_slack_installations'),
});

const liveManual = (tx: IdentityTransaction) => {
  const r = relations(tx);
  return `${r.handles} h
    JOIN ${r.identities} ti ON ti.table_id = h.table_id AND ti.row_id = h.member_id AND ti.live
    LEFT JOIN (${r.accounts} a JOIN ${r.memberships} m ON m.id = a.membership_id AND m.user_id = a.user_id
      AND m.removed_at IS NULL) ON a.member_id = h.member_id`;
};

// No observation dates the login an account was linked with, so it ranks as the oldest alias.
const identityRows = (tx: IdentityTransaction, filter: string, tail: string) => {
  const r = relations(tx);
  return `WITH verified AS (
    SELECT DISTINCT ON (v.member_id, v.provider, v.scope, v.external_id, v.handle)
      NULL::uuid AS id, v.member_id, v.membership_id, v.provider, v.scope, v.external_id, v.handle, v.display_name,
      'verified'::text AS trust, false AS verified_elsewhere, NULL::timestamptz AS updated_at,
      ARRAY(
        SELECT seen.handle FROM (
          SELECT DISTINCT ON (lower(s.handle)) s.handle, s.observed_at FROM (
            SELECT o.handle, o.observed_at FROM ${r.observations} o
            WHERE o.provider = v.provider AND o.scope = v.scope AND o.external_id = v.external_id
            UNION ALL
            SELECT v.fallback_handle, '-infinity'::timestamptz WHERE v.fallback_handle IS NOT NULL
          ) s
          WHERE lower(s.handle) IS DISTINCT FROM lower(v.handle)
          ORDER BY lower(s.handle), s.observed_at DESC
        ) seen ORDER BY seen.observed_at DESC, seen.handle
      ) AS aliases
    FROM ${r.links} v
    ORDER BY v.member_id, v.provider, v.scope, v.external_id, v.handle, v.membership_id
  ), manual AS (
    SELECT h.id, h.member_id, m.id AS membership_id, h.provider, h.scope, h.external_id, h.handle, h.display_name,
      'manual'::text AS trust,
      EXISTS (SELECT 1 FROM ${r.links} v WHERE v.provider = h.provider AND v.scope = h.scope
        AND v.external_id = h.external_id AND v.member_id <> h.member_id) AS verified_elsewhere,
      h.updated_at, '{}'::text[] AS aliases
    FROM ${liveManual(tx)}
  ), identities AS (
    SELECT * FROM verified UNION ALL SELECT * FROM manual
  )
  SELECT i.* FROM identities i WHERE ${filter} ${tail}`;
};

const listOrder = `i.member_id, i.provider, i.trust DESC, i.scope, lower(i.handle) NULLS LAST, i.external_id NULLS LAST, i.id`;

type IdentityRow = {
  id: string | null;
  member_id: string;
  membership_id: string | null;
  provider: string;
  scope: string;
  external_id: string | null;
  handle: string | null;
  display_name: string | null;
  trust: MemberIdentityTrust;
  verified_elsewhere: boolean;
  updated_at: Date | null;
  aliases: string[];
};

function toIdentity(row: IdentityRow): MemberIdentity {
  const provider = identityProvider(row.provider);
  const address = { externalId: row.external_id, handle: row.handle };
  return {
    id: row.id,
    memberId: row.member_id,
    membershipId: row.membership_id,
    provider: row.provider,
    providerLabel: provider.label,
    scope: row.scope,
    externalId: row.external_id,
    handle: row.handle,
    displayName: row.display_name,
    aliases: row.aliases,
    trust: row.trust,
    conflict: row.verified_elsewhere ? 'verified-elsewhere' : null,
    profileUrl: provider.profileUrl(address),
    mention: provider.mention(address),
    updatedAt: row.updated_at?.toISOString() ?? null,
  };
}

export async function identitiesOfMembers(
  tx: IdentityTransaction,
  memberIds: readonly string[],
): Promise<ReadonlyMap<string, readonly MemberIdentity[]>> {
  const result = new Map<string, MemberIdentity[]>();
  if (!hasMemberIdentities(tx) || memberIds.length === 0) return result;
  const { rows } = await tx.client.query<IdentityRow>(
    identityRows(tx, 'i.member_id = ANY($1::uuid[])', `ORDER BY ${listOrder}`),
    [[...new Set(memberIds)]],
  );
  for (const row of rows) {
    const identity = toIdentity(row);
    const list = result.get(identity.memberId);
    if (list) list.push(identity);
    else result.set(identity.memberId, [identity]);
  }
  return result;
}

export async function listMemberIdentities(
  tx: IdentityTransaction,
  memberId: string,
): Promise<readonly MemberIdentity[]> {
  return (await identitiesOfMembers(tx, [memberId])).get(memberId) ?? [];
}

type MatchRow = {
  key: string;
  tier: number;
  trust: MemberIdentityTrust;
  via: IdentityMatch['via'];
  member_id: string;
  membership_id: string | null;
  external_id: string | null;
  handle: string | null;
};

const orNull = <T>(parse: () => T): T | null => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof MemberIdentityError) return null;
    throw error;
  }
};

function decide(key: IdentityResolution['key'], rows: readonly MatchRow[]): IdentityResolution {
  const tier = Math.min(...rows.map(row => row.tier));
  const hits = rows
    .filter(row => row.tier === tier)
    .map(row => ({
      memberId: row.member_id,
      membershipId: row.membership_id,
      trust: row.trust,
      via: row.via,
      externalId: row.external_id,
      handle: row.handle,
    }));
  const [memberId, ...others] = new Set(hits.map(hit => hit.memberId));
  if (!memberId || others.length)
    return {
      key,
      status: memberId ? 'ambiguous' : 'unresolved',
      memberId: null,
      membershipId: null,
      trust: null,
      hits,
    };
  return {
    key,
    status: 'resolved',
    memberId,
    membershipId: hits.find(hit => hit.membershipId)?.membershipId ?? null,
    trust: hits.some(hit => hit.trust === 'verified') ? 'verified' : 'manual',
    hits,
  };
}

export async function resolveMemberIdentities(
  tx: IdentityTransaction,
  query: { provider: string; scope: string; externalIds?: readonly string[]; handles?: readonly string[] },
): Promise<readonly IdentityResolution[]> {
  const provider = normalizeExternalProvider(query.provider);
  const scope = normalizeExternalScope(provider, query.scope);
  const externalKeys = (query.externalIds ?? []).map(value => ({
    key: { kind: 'external-id' as const, value },
    match: orNull(() => normalizeExternalId(value)),
  }));
  const handleKeys = (query.handles ?? []).map(value => ({
    key: { kind: 'handle' as const, value },
    match: orNull(() => normalizeExternalHandle(provider, value)),
  }));
  const r = relations(tx);
  const lookup = async (sql: string, keys: readonly { match: string | null }[]) => {
    const values = [...new Set(keys.flatMap(({ match }) => (match ? [match] : [])))];
    if (!hasMemberIdentities(tx) || values.length === 0) return [];
    return (await tx.client.query<MatchRow>(sql, [provider, scope, values])).rows;
  };
  const verified = 'v.member_id, v.membership_id, v.external_id, v.handle';
  const manual = 'h.member_id, m.id, h.external_id, h.handle';
  const keys = 'unnest($3::text[]) k(value)';
  const byExternalId = await lookup(
    `SELECT k.value AS key, 0 AS tier, 'verified' AS trust, 'external-id' AS via,
      v.member_id, v.membership_id, v.external_id, v.handle
    FROM ${r.links} v JOIN ${keys} ON v.external_id = k.value WHERE v.provider = $1 AND v.scope = $2
    UNION
    SELECT k.value, 1, 'manual', 'external-id', ${manual}
    FROM ${liveManual(tx)} JOIN ${keys} ON h.external_id = k.value WHERE h.provider = $1 AND h.scope = $2`,
    externalKeys,
  );
  const byHandle = await lookup(
    `SELECT k.value AS key, 0 AS tier, 'verified' AS trust, 'handle' AS via,
      v.member_id, v.membership_id, v.external_id, v.handle
    FROM ${r.links} v JOIN ${keys} ON lower(v.handle) = lower(k.value) WHERE v.provider = $1 AND v.scope = $2
    UNION
    SELECT k.value, 1, 'verified', 'alias', ${verified}
    FROM ${r.observations} o JOIN ${keys} ON o.handle_key = lower(k.value)
    JOIN ${r.links} v ON v.provider = o.provider AND v.scope = o.scope AND v.external_id = o.external_id
    WHERE o.provider = $1 AND o.scope = $2
    UNION
    SELECT k.value, 1, 'verified', 'alias', ${verified}
    FROM ${r.links} v JOIN ${keys} ON lower(v.fallback_handle) = lower(k.value)
    WHERE v.provider = $1 AND v.scope = $2
    UNION
    SELECT k.value, 1, 'manual', 'handle', ${manual}
    FROM ${liveManual(tx)} JOIN ${keys} ON h.handle_key = lower(k.value) WHERE h.provider = $1 AND h.scope = $2`,
    handleKeys,
  );
  const resolve = (entries: typeof externalKeys | typeof handleKeys, rows: readonly MatchRow[]) =>
    entries.map(({ key, match }) => decide(key, match ? rows.filter(row => row.key === match) : []));
  return [...resolve(externalKeys, byExternalId), ...resolve(handleKeys, byHandle)];
}

export type OutboundMemberTarget = {
  memberId: string;
  externalId: string;
  trust: MemberIdentityTrust;
};

export async function resolveOutboundMemberIdentities(
  tx: IdentityTransaction,
  query: {
    targetProvider: string;
    targetScope: string;
    handles?: readonly string[];
    targetExternalIds?: readonly string[];
  },
): Promise<{
  byHandle: ReadonlyMap<string, OutboundMemberTarget>;
  knownExternalIds: ReadonlySet<string>;
}> {
  const provider = normalizeExternalProvider(query.targetProvider);
  const scope = normalizeExternalScope(provider, query.targetScope);
  const handleKeys = [
    ...new Set(
      (query.handles ?? []).flatMap(raw => {
        const normalized = orNull(() => normalizeExternalHandle(provider, raw).toLowerCase());
        return normalized ? [normalized] : [];
      }),
    ),
  ];
  const externalIds = [
    ...new Set(
      (query.targetExternalIds ?? []).flatMap(raw => {
        const normalized = orNull(() => normalizeExternalId(raw));
        return normalized ? [normalized] : [];
      }),
    ),
  ];
  const byHandle = new Map<string, OutboundMemberTarget>();
  const knownExternalIds = new Set<string>();
  if (!hasMemberIdentities(tx) || (handleKeys.length === 0 && externalIds.length === 0))
    return { byHandle, knownExternalIds };
  const r = relations(tx);
  if (externalIds.length > 0) {
    const { rows } = await tx.client.query<{ external_id: string }>(
      `SELECT k.value AS external_id
      FROM unnest($3::text[]) k(value)
      WHERE EXISTS (
        SELECT 1 FROM ${r.links} v WHERE v.provider = $1 AND v.scope = $2 AND v.external_id = k.value
      ) OR EXISTS (
        SELECT 1 FROM ${liveManual(tx)} WHERE h.provider = $1 AND h.scope = $2 AND h.external_id = k.value
      )`,
      [provider, scope, externalIds],
    );
    for (const row of rows) knownExternalIds.add(row.external_id);
  }
  if (handleKeys.length === 0) return { byHandle, knownExternalIds };
  const { rows: handleHits } = await tx.client.query<{ key: string; tier: number; member_id: string }>(
    `SELECT k.key, CASE WHEN v.provider = $1 AND v.scope = $2 THEN 0 ELSE 2 END AS tier, v.member_id
    FROM ${r.links} v JOIN unnest($3::text[]) k(key) ON lower(v.handle) = k.key
    UNION
    SELECT k.key, CASE WHEN v.provider = $1 AND v.scope = $2 THEN 1 ELSE 3 END, v.member_id
    FROM ${r.observations} o JOIN unnest($3::text[]) k(key) ON o.handle_key = k.key
    JOIN ${r.links} v ON v.provider = o.provider AND v.scope = o.scope AND v.external_id = o.external_id
    UNION
    SELECT k.key, CASE WHEN v.provider = $1 AND v.scope = $2 THEN 1 ELSE 3 END, v.member_id
    FROM ${r.links} v JOIN unnest($3::text[]) k(key) ON lower(v.fallback_handle) = k.key
    UNION
    SELECT k.key, CASE WHEN h.provider = $1 AND h.scope = $2 THEN 1 ELSE 3 END, h.member_id
    FROM ${liveManual(tx)} JOIN unnest($3::text[]) k(key) ON h.handle_key = k.key`,
    [provider, scope, handleKeys],
  );
  const memberByHandle = new Map<string, string>();
  for (const key of handleKeys) {
    const hits = handleHits.filter(row => row.key === key);
    if (hits.length === 0) continue;
    const minTier = Math.min(...hits.map(row => row.tier));
    const [memberId, ...others] = new Set(hits.filter(row => row.tier === minTier).map(row => row.member_id));
    if (memberId && others.length === 0) memberByHandle.set(key, memberId);
  }
  if (memberByHandle.size === 0) return { byHandle, knownExternalIds };
  const memberIds = [...new Set(memberByHandle.values())];
  const { rows: targetHits } = await tx.client.query<{
    member_id: string;
    external_id: string;
    tier: number;
    trust: MemberIdentityTrust;
  }>(
    `SELECT member_id, external_id, 0 AS tier, 'verified'::text AS trust
    FROM ${r.links}
    WHERE provider = $1 AND scope = $2 AND member_id = ANY($3::uuid[]) AND external_id IS NOT NULL
    UNION
    SELECT h.member_id, h.external_id, 1 AS tier, 'manual'::text AS trust
    FROM ${liveManual(tx)}
    WHERE h.provider = $1 AND h.scope = $2 AND h.member_id = ANY($3::uuid[]) AND h.external_id IS NOT NULL`,
    [provider, scope, memberIds],
  );
  const targetByMember = new Map<string, OutboundMemberTarget>();
  for (const memberId of memberIds) {
    const hits = targetHits.filter(row => row.member_id === memberId);
    if (hits.length === 0) continue;
    const minTier = Math.min(...hits.map(row => row.tier));
    const best = hits.filter(row => row.tier === minTier);
    const [externalId, ...others] = new Set(best.map(row => row.external_id));
    if (externalId && others.length === 0)
      targetByMember.set(memberId, {
        memberId,
        externalId,
        trust: best.some(row => row.trust === 'verified') ? 'verified' : 'manual',
      });
  }
  for (const [key, memberId] of memberByHandle) {
    const target = targetByMember.get(memberId);
    if (target) byHandle.set(key, target);
  }
  return { byHandle, knownExternalIds };
}

export async function searchMemberIdentities(
  tx: IdentityTransaction,
  needle: string,
  options: { provider?: string; limit?: number } = {},
): Promise<readonly MemberIdentity[]> {
  const term = needle.trim().replace(/^@/, '');
  if (!hasMemberIdentities(tx) || !term) return [];
  const provider = options.provider === undefined ? null : normalizeExternalProvider(options.provider);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
  const pattern = `%${term.replace(/[\\%_]/g, character => `\\${character}`)}%`;
  const like = (column: string) => `lower(${column}) LIKE lower($1) ESCAPE '\\'`;
  const { rows } = await tx.client.query<IdentityRow>(
    identityRows(
      tx,
      `($2::text IS NULL OR i.provider = $2) AND (${like('i.handle')} OR ${like('i.external_id')}
        OR ${like('i.display_name')} OR EXISTS (SELECT 1 FROM unnest(i.aliases) alias WHERE ${like('alias')}))`,
      `ORDER BY (lower(i.handle) = lower($3) OR lower(i.external_id) = lower($3)) DESC, ${listOrder} LIMIT $4`,
    ),
    [pattern, provider, term, limit],
  );
  return rows.map(toIdentity);
}

export async function observeExternalHandle(
  tx: IdentityTransaction,
  input: {
    provider: string;
    scope: string;
    externalId: string;
    handle: string;
    priorHandle?: string | null;
    source: 'oauth' | 'webhook';
    observedAt?: Date;
  },
): Promise<'recorded' | 'unchanged' | 'unlinked' | 'unsupported'> {
  if (!hasMemberIdentities(tx)) return 'unsupported';
  const provider = normalizeExternalProvider(input.provider);
  const scope = normalizeExternalScope(provider, input.scope);
  const externalId = normalizeExternalId(input.externalId);
  const handle = normalizeExternalHandle(provider, input.handle);
  const prior = input.priorHandle?.trim() ? normalizeExternalHandle(provider, input.priorHandle) : null;
  const observedAt = input.observedAt ?? new Date();
  const account = [provider, scope, externalId];
  const r = relations(tx);
  const link = (
    await tx.client.query<{ original: string | null; renamed: boolean }>(
      `SELECT COALESCE(fallback_handle, handle) AS original,
        lower(COALESCE(fallback_handle, handle)) IS DISTINCT FROM lower($4::text) AS renamed
      FROM ${r.links} WHERE provider = $1 AND scope = $2 AND external_id = $3 LIMIT 1`,
      [...account, handle],
    )
  ).rows[0];
  if (!link) return 'unlinked';
  await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${tx.schema}:${provider}:${scope}:${externalId}`,
  ]);
  const seen = (
    await tx.client.query<{ handle: string; current: boolean; newer: boolean; same: boolean }>(
      `SELECT handle, current, $4::timestamptz >= observed_at AS newer, handle_key = lower($5::text) AS same
      FROM ${r.observations} WHERE provider = $1 AND scope = $2 AND external_id = $3`,
      [...account, observedAt, handle],
    )
  ).rows;
  const insert = `INSERT INTO ${r.observations} AS o
    (provider, scope, external_id, handle, handle_key, source, observed_at, current)
    VALUES ($1, $2, $3, $4::text, lower($4::text), $5, $6, $7)`;
  // The handle the account was linked with predates every observation, so seed it before recording a rename.
  const seedHandle =
    prior &&
    prior.toLowerCase() !== handle.toLowerCase() &&
    !seen.some(row => row.handle.toLowerCase() === prior.toLowerCase())
      ? prior
      : seen.length === 0 && link.renamed && link.original && handlePattern.test(link.original)
        ? link.original
        : null;
  if (seedHandle)
    await tx.client.query(`${insert} ON CONFLICT DO NOTHING`, [
      ...account,
      seedHandle,
      'oauth',
      new Date(observedAt.getTime() - 1),
      false,
    ]);
  const current = seen.find(row => row.current);
  const known = seen.find(row => row.same);
  const promote = !current || current.newer;
  if (promote && current && !current.same)
    await tx.client.query(
      `UPDATE ${r.observations} SET current = false WHERE provider = $1 AND scope = $2 AND external_id = $3 AND current`,
      account,
    );
  await tx.client.query(
    `${insert} ON CONFLICT (provider, scope, external_id, handle_key) DO UPDATE SET
      handle = CASE WHEN EXCLUDED.observed_at >= o.observed_at THEN EXCLUDED.handle ELSE o.handle END,
      source = CASE WHEN EXCLUDED.observed_at >= o.observed_at THEN EXCLUDED.source ELSE o.source END,
      observed_at = GREATEST(o.observed_at, EXCLUDED.observed_at),
      current = o.current OR EXCLUDED.current`,
    [...account, handle, input.source, observedAt, promote],
  );
  const changed =
    Boolean(seedHandle) || !known || (promote && !known.current) || (known.newer && known.handle !== handle);
  return changed ? 'recorded' : 'unchanged';
}

const parsed = (value: string | null | undefined, parse: (raw: string) => string) =>
  value?.trim() ? parse(value) : null;

function requireMemberIdentities(tx: IdentityTransaction) {
  if (!hasMemberIdentities(tx)) throw new MemberIdentityError('unsupported');
}

async function assertUnclaimed(
  tx: IdentityTransaction,
  identity: { id: string | null; memberId: string; provider: string; scope: string },
  values: { externalId: string | null; handle: string | null },
) {
  const r = relations(tx);
  const { rows } = await tx.client.query<{ claimed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${r.links} WHERE provider = $1 AND scope = $2 AND external_id = $3::text)
      OR EXISTS (SELECT 1 FROM ${r.handles} h
        JOIN ${r.identities} ti ON ti.table_id = h.table_id AND ti.row_id = h.member_id AND ti.live
        WHERE h.provider = $1 AND h.scope = $2 AND h.external_id = $3::text AND h.id IS DISTINCT FROM $6::uuid)
      OR EXISTS (SELECT 1 FROM ${r.handles} h
        JOIN ${r.identities} ti ON ti.table_id = h.table_id AND ti.row_id = h.member_id AND ti.live
        WHERE h.member_id = $4 AND h.provider = $1 AND h.scope = $2
        AND h.handle_key = lower($5::text) AND h.id IS DISTINCT FROM $6::uuid) AS claimed`,
    [identity.provider, identity.scope, values.externalId, identity.memberId, values.handle, identity.id],
  );
  if (rows[0]?.claimed) throw new MemberIdentityError('identity-claimed');
}

const claimed = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === '23505' ? new MemberIdentityError('identity-claimed') : error;

async function manualIdentity(tx: IdentityTransaction, id: string): Promise<MemberIdentity> {
  const { rows } = await tx.client.query<IdentityRow>(identityRows(tx, 'i.id = $1', ''), [id]);
  if (!rows[0]) throw new MemberIdentityError('identity-not-found');
  return toIdentity(rows[0]);
}

export async function addManualMemberIdentity(
  tx: IdentityTransaction,
  input: {
    tableId: string;
    memberId: string;
    createdByMembershipId: string;
    provider: string;
    scope?: string | null;
    externalId?: string | null;
    handle?: string | null;
    displayName?: string | null;
  },
): Promise<MemberIdentity> {
  requireMemberIdentities(tx);
  const provider = normalizeExternalProvider(input.provider);
  if (!identityProvider(provider).supportsManual) throw new MemberIdentityError('manual-not-allowed');
  const r = relations(tx);
  const slackTeam =
    provider === 'slack' && !input.scope?.trim()
      ? ((
          await tx.client.query<{ team_id: string }>(
            `SELECT team_id FROM ${r.slackInstallations} WHERE state IN ('active', 'scope-missing')
            ORDER BY created_at DESC LIMIT 1`,
          )
        ).rows[0]?.team_id ?? null)
      : null;
  const scope = normalizeExternalScope(provider, input.scope, slackTeam);
  const externalId = parsed(input.externalId, normalizeExternalId);
  const handle = parsed(input.handle, raw => normalizeExternalHandle(provider, raw));
  const displayName = parsed(input.displayName, normalizeDisplayName);
  if (!externalId && !handle) throw new MemberIdentityError('identity-incomplete');
  const member = await tx.client.query(
    `SELECT 1 FROM ${r.systemTables} s JOIN ${r.identities} ti ON ti.table_id = s.table_id
    WHERE s.kind = 'workspace-members' AND s.table_id = $1 AND ti.row_id = $2 AND ti.live
    FOR SHARE OF ti`,
    [input.tableId, input.memberId],
  );
  if (!member.rowCount) throw new MemberIdentityError('member-not-found');
  await assertUnclaimed(tx, { id: null, memberId: input.memberId, provider, scope }, { externalId, handle });
  const inserted = await tx.client
    .query<{ id: string }>(
      `INSERT INTO ${r.handles} (table_id, member_id, provider, scope, external_id, handle, display_name,
        created_by_membership_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [input.tableId, input.memberId, provider, scope, externalId, handle, displayName, input.createdByMembershipId],
    )
    .catch(error => {
      throw claimed(error);
    });
  return manualIdentity(tx, inserted.rows[0]!.id);
}

export async function updateManualMemberIdentity(
  tx: IdentityTransaction,
  input: {
    memberId: string;
    identityId: string;
    externalId?: string | null;
    handle?: string | null;
    displayName?: string | null;
  },
): Promise<MemberIdentity> {
  requireMemberIdentities(tx);
  const r = relations(tx);
  const current = (
    await tx.client.query<{
      provider: string;
      scope: string;
      external_id: string | null;
      handle: string | null;
      display_name: string | null;
    }>(
      `SELECT h.provider, h.scope, h.external_id, h.handle, h.display_name FROM ${liveManual(tx)}
      WHERE h.id = $1 AND h.member_id = $2 FOR UPDATE OF h`,
      [input.identityId, input.memberId],
    )
  ).rows[0];
  if (!current) throw new MemberIdentityError('identity-not-found');
  const next = (value: string | null | undefined, existing: string | null, parse: (raw: string) => string) =>
    value === undefined ? existing : parsed(value, parse);
  const externalId = next(input.externalId, current.external_id, normalizeExternalId);
  const handle = next(input.handle, current.handle, raw => normalizeExternalHandle(current.provider, raw));
  const displayName = next(input.displayName, current.display_name, normalizeDisplayName);
  if (!externalId && !handle) throw new MemberIdentityError('identity-incomplete');
  await assertUnclaimed(
    tx,
    { id: input.identityId, memberId: input.memberId, provider: current.provider, scope: current.scope },
    { externalId, handle },
  );
  await tx.client
    .query(
      `UPDATE ${r.handles} SET external_id = $2, handle = $3, display_name = $4, updated_at = clock_timestamp()
      WHERE id = $1`,
      [input.identityId, externalId, handle, displayName],
    )
    .catch(error => {
      throw claimed(error);
    });
  return manualIdentity(tx, input.identityId);
}

export async function removeManualMemberIdentity(
  tx: IdentityTransaction,
  input: { memberId: string; identityId: string },
): Promise<void> {
  requireMemberIdentities(tx);
  const deleted = await tx.client.query(`DELETE FROM ${relations(tx).handles} WHERE id = $1 AND member_id = $2`, [
    input.identityId,
    input.memberId,
  ]);
  if (!deleted.rowCount) throw new MemberIdentityError('identity-not-found');
}
