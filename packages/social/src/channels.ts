import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  requireAgentGrant,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { validateIntegrationRecipients } from '@tulipfarm/integrations/authorization';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { SocialPlatformAdapter } from './adapter.ts';
import { socialAccountAccess, socialCompatibility, type SocialAccounts, type SocialRuntime } from './accounts.ts';
import {
  addChannelSchema,
  channelGrantsSchema,
  channelKindSchema,
  discoveredChannelSchema,
  engagementPolicySchema,
  isChannelKindFor,
  platformSchema,
  targetIssue,
  targetSchema,
  accountStateSchema,
  type Channel,
  type DiscoveredChannel,
  type Platform,
  type Target,
  type ValidationError,
} from './contracts.ts';
import { SocialError } from './credentials.ts';

export const channelPermissions = ['publish', 'analytics', 'engagement', 'manage'] as const;
export type ChannelPermission = (typeof channelPermissions)[number];
/**
 * Who acts on a channel: a member, or an agent acting for its sponsor. An agent holds no channel grants of its
 * own; it uses the sponsor's, never `manage` (PRODUCT 11).
 */
export type ChannelPrincipal = string | HumanActor | { kind: 'agent'; agentId: string; sponsor: string | HumanActor };
/** Versions a command read earlier. Any that changed since makes it stop (TECH, Channels and grants). */
export type ChannelExpectations = {
  channelVersion?: number;
  accountGeneration?: number;
  accountGrantsVersion?: number;
};
/** The most channels one discovery returns. */
export const discoveryLimit = 1000;

const uuid = z.uuid();
const channelRowSchema = z.object({
  id: z.uuid(),
  account_id: z.uuid(),
  platform: platformSchema,
  channel_kind: channelKindSchema,
  platform_channel_id: z.string(),
  display_name: z.string(),
  account_generation: z.number().int().positive(),
  version: z.number().int().positive(),
  enabled: z.boolean(),
  engagement_policy: engagementPolicySchema,
  removed_at: z.date().nullable(),
});
type ChannelRow = z.infer<typeof channelRowSchema>;
const accountRowSchema = z.object({
  id: z.uuid(),
  platform: platformSchema,
  ownership: z.enum(['personal', 'business']),
  owner_membership_id: z.uuid().nullable(),
  generation: z.number().int().positive(),
  grants_version: z.number().int().positive(),
  state: accountStateSchema,
});
type AccountRow = z.infer<typeof accountRowSchema>;
const grantRowsSchema = z.array(
  z.object({
    permission: z.enum(channelPermissions),
    membership_id: z.uuid().nullable(),
    team_id: z.uuid().nullable(),
  }),
);

export type AuthorizedChannel = {
  channel: Channel;
  account: { id: string; platform: Platform; generation: number; grantsVersion: number };
  /** The member whose grants were used: the caller, or the agent's sponsor. */
  sponsorMembershipId: string;
  agentId: string | null;
};

export function createSocialChannels(options: {
  runtime: SocialRuntime;
  accounts: Pick<SocialAccounts, 'accessToken' | 'tokenRejected'>;
  adapters: Partial<Record<Platform, SocialPlatformAdapter>>;
  /**
   * The agent permission limits for an agent acting for `sponsor`. The default requires the sponsor to hold
   * `invoke` on the agent; the composition may supply the agents domain's fuller check.
   */
  agentPermission?: (tx: AuthorizationTransaction, sponsor: HumanActor, agentId: string) => Promise<void>;
}) {
  const relation = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_social_${name}`);
  const agentPermission =
    options.agentPermission ??
    ((tx: AuthorizationTransaction, sponsor: HumanActor, agentId: string) =>
      requireAgentGrant(tx, sponsor, agentId, 'invoke'));
  const adapterFor = (platform: Platform) => {
    const adapter = options.adapters[platform];
    if (!adapter || adapter.platform !== platform) throw new SocialError('platform-unavailable');
    return adapter;
  };

  async function transaction<T>(
    workspaceId: string,
    mode: 'read' | 'write',
    operation: (tx: AuthorizationTransaction) => Promise<T>,
  ) {
    return options.runtime.transaction(uuid.parse(workspaceId), socialCompatibility, async tx => {
      await lockAuthorization(tx, mode);
      return operation(tx);
    });
  }
  async function human(tx: AuthorizationTransaction, principal: string | HumanActor) {
    const actor = typeof principal === 'string' ? await resolveHuman(tx, principal) : principal;
    await currentMember(tx, actor);
    return actor;
  }
  async function resolvePrincipal(tx: AuthorizationTransaction, principal: ChannelPrincipal) {
    if (typeof principal === 'object' && principal.kind === 'agent') {
      const sponsor = await human(tx, principal.sponsor);
      const agentId = uuid.parse(principal.agentId);
      await agentPermission(tx, sponsor, agentId);
      return { sponsor, agentId };
    }
    return { sponsor: await human(tx, principal), agentId: null };
  }
  async function loadAccount(tx: AuthorizationTransaction, id: string, lock = false) {
    const row = accountRowSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT id,platform,ownership,owner_membership_id,generation,grants_version,state FROM ${relation(tx, 'accounts')} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
            [uuid.parse(id)],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }
  async function loadChannel(tx: AuthorizationTransaction, id: string, lock = false) {
    const row = channelRowSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT * FROM ${relation(tx, 'channels')} WHERE id=$1 AND removed_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
            [uuid.parse(id)],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }
  const accountAccess = (tx: AuthorizationTransaction, actor: HumanActor, account: AccountRow) =>
    socialAccountAccess(tx, actor.membershipId, {
      id: account.id,
      ownership: account.ownership,
      ownerMembershipId: account.owner_membership_id,
    });
  async function grantRows(tx: AuthorizationTransaction, channelId: string) {
    return grantRowsSchema.parse(
      (
        await tx.client.query(
          `SELECT permission,membership_id,team_id FROM ${relation(tx, 'channel_grants')} WHERE channel_id=$1 ORDER BY membership_id,team_id`,
          [channelId],
        )
      ).rows,
    );
  }
  async function grantSet(tx: AuthorizationTransaction, channelId: string) {
    const rows = await grantRows(tx, channelId);
    const set = (permission: ChannelPermission) => ({
      memberIds: rows.flatMap(row => (row.permission === permission && row.membership_id ? [row.membership_id] : [])),
      teamIds: rows.flatMap(row => (row.permission === permission && row.team_id ? [row.team_id] : [])),
    });
    return {
      publish: set('publish'),
      analytics: set('analytics'),
      engagement: set('engagement'),
      manage: set('manage'),
    };
  }
  /** The channel permissions a membership holds directly or through a team. */
  async function held(tx: AuthorizationTransaction, membershipId: string, channelId: string) {
    return z
      .array(z.object({ permission: z.enum(channelPermissions) }))
      .parse(
        (
          await tx.client.query(
            `SELECT DISTINCT g.permission FROM ${relation(tx, 'channel_grants')} g
             LEFT JOIN ${qualified(tx.schema, 'tf_member_teams')} mt ON mt.team_id=g.team_id AND mt.membership_id=$2
             WHERE g.channel_id=$1 AND (g.membership_id=$2 OR mt.membership_id IS NOT NULL)`,
            [channelId, membershipId],
          )
        ).rows,
      )
      .map(row => row.permission);
  }
  async function toChannel(tx: AuthorizationTransaction, row: ChannelRow): Promise<Channel> {
    return {
      id: row.id,
      accountId: row.account_id,
      platform: row.platform,
      channelKind: row.channel_kind,
      platformChannelId: row.platform_channel_id,
      displayName: row.display_name,
      accountGeneration: row.account_generation,
      version: row.version,
      enabled: row.enabled,
      engagementPolicy: row.engagement_policy,
      grants: await grantSet(tx, row.id),
    };
  }
  async function audit(tx: AuthorizationTransaction, actor: HumanActor, id: string, operation: string) {
    await tx.client.query(
      `INSERT INTO ${qualified(tx.schema, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,$3,$4)`,
      [randomUUID(), actor.membershipId, `social-channel.${operation}`, id],
    );
  }

  /**
   * The one channel check. A permission is the channel grant itself; reaching the channel through the
   * connection grants nothing (PRODUCT 10). Each permission is checked on its own (PRODUCT 11). Using a
   * channel also needs `use` on its connection, and the channel must still be bound to the connection's
   * current `generation` (PRODUCT 8). Grants are checked before state so a refusal reveals nothing.
   */
  async function check(
    tx: AuthorizationTransaction,
    sponsor: HumanActor,
    channel: ChannelRow,
    account: AccountRow,
    permission: ChannelPermission,
    expected: ChannelExpectations,
  ) {
    if (!(await held(tx, sponsor.membershipId, channel.id)).includes(permission)) throw new AccessDenied();
    const access = await accountAccess(tx, sponsor, account);
    if (!(permission === 'manage' ? access.read : access.use)) throw new AccessDenied();
    if (expected.channelVersion !== undefined && expected.channelVersion !== channel.version)
      throw new SocialError('channel-conflict');
    if (expected.accountGrantsVersion !== undefined && expected.accountGrantsVersion !== account.grants_version)
      throw new SocialError('account-conflict');
    if (expected.accountGeneration !== undefined && expected.accountGeneration !== account.generation)
      throw new SocialError('account-reconnect-required');
    if (permission === 'manage') return;
    if (channel.account_generation !== account.generation || account.state === 'reconnect-required')
      throw new SocialError('account-reconnect-required');
    if (account.state !== 'active') throw new SocialError('account-unavailable');
    if (!channel.enabled) throw new SocialError('channel-unavailable');
  }
  async function authorizeIn(
    tx: AuthorizationTransaction,
    principal: ChannelPrincipal,
    channelId: string,
    permission: ChannelPermission,
    expected: ChannelExpectations,
    lock = false,
  ) {
    const { sponsor, agentId } = await resolvePrincipal(tx, principal);
    // Adding a channel, editing its grants and its policy are left to people (PRODUCT 11).
    if (agentId && permission === 'manage') throw new AccessDenied();
    const channel = await loadChannel(tx, channelId, lock);
    const account = await loadAccount(tx, channel.account_id);
    await check(tx, sponsor, channel, account, permission, expected);
    return { sponsor, agentId, channel, account };
  }
  /** The channels the token can reach now. Nothing is added (PRODUCT 10). */
  async function reachable(workspaceId: string, account: AccountRow) {
    const adapter = adapterFor(account.platform);
    const access = await options.accounts.accessToken(workspaceId, account.id);
    if (access.account.generation !== account.generation) throw new SocialError('account-conflict');
    let listed: unknown[];
    try {
      listed = await adapter.listChannels(access.token);
    } catch (error) {
      const kind = adapter.classify(error instanceof Error ? error : new Error(String(error)), 'before-send');
      if (kind === 'reconnect') {
        await options.accounts.tokenRejected(workspaceId, account.id, access.account.generation);
        throw new SocialError('account-reconnect-required');
      }
      throw new SocialError('account-unavailable');
    }
    const channels: DiscoveredChannel[] = [];
    const seen = new Set<string>();
    for (const item of listed) {
      const parsed = discoveredChannelSchema.safeParse(item);
      if (!parsed.success || !isChannelKindFor(account.platform, parsed.data.channelKind)) continue;
      if (seen.has(parsed.data.platformChannelId)) continue;
      seen.add(parsed.data.platformChannelId);
      channels.push(parsed.data);
      if (channels.length >= discoveryLimit) break;
    }
    return channels;
  }
  /** Loads a connection for a channel manager-only command: the caller must manage the connection. */
  async function managedAccount(workspaceId: string, userId: string, accountId: string) {
    return transaction(workspaceId, 'read', async tx => {
      const actor = await human(tx, userId);
      const account = await loadAccount(tx, accountId);
      if (!(await accountAccess(tx, actor, account)).manage) throw new AccessDenied();
      if (account.state !== 'active')
        throw new SocialError(
          account.state === 'reconnect-required' ? 'account-reconnect-required' : 'account-unavailable',
        );
      return account;
    });
  }

  /**
   * Checks that `principal` holds `permission` on a channel, against the versions it read earlier. Every
   * later slice that publishes, reads analytics or handles engagement goes through this check.
   */
  async function authorize(
    workspaceId: string,
    principal: ChannelPrincipal,
    channelId: string,
    permission: ChannelPermission,
    expected: ChannelExpectations = {},
  ): Promise<AuthorizedChannel> {
    return transaction(workspaceId, 'read', tx => authorizeWithin(tx, principal, channelId, permission, expected));
  }
  /** `authorize` inside a caller's transaction, which already holds the authorization lock. */
  async function authorizeWithin(
    tx: AuthorizationTransaction,
    principal: ChannelPrincipal,
    channelId: string,
    permission: ChannelPermission,
    expected: ChannelExpectations = {},
  ): Promise<AuthorizedChannel> {
    const result = await authorizeIn(tx, principal, channelId, permission, expected);
    return {
      channel: await toChannel(tx, result.channel),
      account: {
        id: result.account.id,
        platform: result.account.platform,
        generation: result.account.generation,
        grantsVersion: result.account.grants_version,
      },
      sponsorMembershipId: result.sponsor.membershipId,
      agentId: result.agentId,
    };
  }

  return {
    /** Lists the channels a connection can reach, for its managers. Discovery adds none (PRODUCT 10). */
    async discover(workspaceId: string, userId: string, accountId: string): Promise<DiscoveredChannel[]> {
      return reachable(workspaceId, await managedAccount(workspaceId, userId, accountId));
    },
    /**
     * Adds one reachable channel, bound to the connection's current `generation`. Only a manager of the
     * connection may add it, and the adder receives only `manage` on the channel: publishing, analytics and
     * engagement are granted separately (PRODUCT 10, 11). A channel left on an older generation by a
     * reconnect is bound again, and its `version` increases.
     */
    async add(workspaceId: string, userId: string, input: unknown): Promise<Channel> {
      const value = addChannelSchema.parse(input);
      const account = await managedAccount(workspaceId, userId, value.accountId);
      if (account.generation !== value.expectedAccountGeneration) throw new SocialError('account-conflict');
      const found = (await reachable(workspaceId, account)).find(
        channel => channel.platformChannelId === value.platformChannelId,
      );
      if (!found) throw new SocialError('channel-unreachable');
      return transaction(workspaceId, 'write', async tx => {
        const actor = await human(tx, userId);
        const latest = await loadAccount(tx, account.id, true);
        if (!(await accountAccess(tx, actor, latest)).manage) throw new AccessDenied();
        if (latest.generation !== value.expectedAccountGeneration || latest.state !== 'active')
          throw new SocialError('account-conflict');
        const existing = channelRowSchema
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT * FROM ${relation(tx, 'channels')} WHERE account_id=$1 AND platform_channel_id=$2 AND removed_at IS NULL FOR UPDATE`,
                [latest.id, found.platformChannelId],
              )
            ).rows[0],
          );
        if (existing && existing.account_generation === latest.generation) throw new SocialError('channel-conflict');
        let id: string;
        if (existing) {
          id = existing.id;
          await tx.client.query(
            `UPDATE ${relation(tx, 'channels')} SET account_generation=$2,display_name=$3,handle=$4,avatar_url=$5,version=version+1 WHERE id=$1`,
            [id, latest.generation, found.displayName, found.handle, found.avatarUrl],
          );
          await audit(tx, actor, id, 'rebind');
        } else {
          id = randomUUID();
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'channels')} (id,account_id,platform,channel_kind,platform_channel_id,display_name,handle,avatar_url,account_generation)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              id,
              latest.id,
              latest.platform,
              found.channelKind,
              found.platformChannelId,
              found.displayName,
              found.handle,
              found.avatarUrl,
              latest.generation,
            ],
          );
          await audit(tx, actor, id, 'add');
        }
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'channel_grants')} (channel_id,permission,membership_id) VALUES ($1,'manage',$2) ON CONFLICT DO NOTHING`,
          [id, actor.membershipId],
        );
        return toChannel(tx, await loadChannel(tx, id));
      });
    },
    /** Channels on which the caller holds any grant, through a connection they can still read. */
    async list(
      workspaceId: string,
      userId: string,
      filter: { accountId?: string | undefined; platform?: Platform | undefined } = {},
    ) {
      return transaction(workspaceId, 'read', async tx => {
        const actor = await human(tx, userId);
        const rows = z.array(channelRowSchema).parse(
          (
            await tx.client.query(
              `SELECT c.* FROM ${relation(tx, 'channels')} c WHERE c.removed_at IS NULL
                 AND ($2::uuid IS NULL OR c.account_id=$2) AND ($3::text IS NULL OR c.platform=$3)
                 AND EXISTS (SELECT 1 FROM ${relation(tx, 'channel_grants')} g
                   LEFT JOIN ${qualified(tx.schema, 'tf_member_teams')} mt ON mt.team_id=g.team_id AND mt.membership_id=$1
                   WHERE g.channel_id=c.id AND (g.membership_id=$1 OR mt.membership_id IS NOT NULL))
               ORDER BY c.created_at,c.id LIMIT $4`,
              [
                actor.membershipId,
                filter.accountId ? uuid.parse(filter.accountId) : null,
                filter.platform ? platformSchema.parse(filter.platform) : null,
                discoveryLimit,
              ],
            )
          ).rows,
        );
        const channels: Channel[] = [];
        const accounts = new Map<string, boolean>();
        for (const row of rows) {
          if (!accounts.has(row.account_id))
            accounts.set(row.account_id, (await accountAccess(tx, actor, await loadAccount(tx, row.account_id))).read);
          if (accounts.get(row.account_id)) channels.push(await toChannel(tx, row));
        }
        return channels;
      });
    },
    async get(workspaceId: string, userId: string, channelId: string): Promise<Channel> {
      return transaction(workspaceId, 'read', async tx => {
        const actor = await human(tx, userId);
        const row = await loadChannel(tx, channelId);
        if (!(await held(tx, actor.membershipId, row.id)).length) throw new AccessDenied();
        if (!(await accountAccess(tx, actor, await loadAccount(tx, row.account_id))).read) throw new AccessDenied();
        return toChannel(tx, row);
      });
    },
    /**
     * Replaces every grant on a channel. The channel's `version` must match and increases, so work bound to
     * the old grants stops. A personal connection's channels can be granted only to its owner (PRODUCT 9, 11).
     */
    async setGrants(workspaceId: string, userId: string, channelId: string, input: unknown): Promise<Channel> {
      const value = channelGrantsSchema.parse(input);
      return transaction(workspaceId, 'write', async tx => {
        const { sponsor: actor, channel, account } = await authorizeIn(tx, userId, channelId, 'manage', {}, true);
        if (channel.version !== value.expectedVersion) throw new SocialError('channel-conflict');
        const grants = {
          publish: value.publish,
          analytics: value.analytics,
          engagement: value.engagement,
          manage: value.manage,
        };
        const memberIds = [...new Set(Object.values(grants).flatMap(set => set.memberIds))];
        const teamIds = [...new Set(Object.values(grants).flatMap(set => set.teamIds))];
        if (
          account.ownership === 'personal' &&
          (teamIds.length > 0 || memberIds.some(id => id !== account.owner_membership_id))
        )
          throw new SocialError('grants-invalid');
        const retained = (await grantRows(tx, channel.id)).flatMap(row => (row.team_id ? [row.team_id] : []));
        await validateIntegrationRecipients(tx, actor, { memberIds, teamIds }, retained);
        const active = await tx.client.query(
          `SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} m WHERE m.removed_at IS NULL AND
           (m.id=ANY($1::uuid[]) OR EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_member_teams')} mt WHERE mt.membership_id=m.id AND mt.team_id=ANY($2::uuid[]))) LIMIT 1`,
          [value.manage.memberIds, value.manage.teamIds],
        );
        if (!active.rowCount) throw new SocialError('grants-invalid');
        await tx.client.query(`DELETE FROM ${relation(tx, 'channel_grants')} WHERE channel_id=$1`, [channel.id]);
        for (const permission of channelPermissions) {
          for (const memberId of new Set(grants[permission].memberIds))
            await tx.client.query(
              `INSERT INTO ${relation(tx, 'channel_grants')} (channel_id,permission,membership_id) VALUES ($1,$2,$3)`,
              [channel.id, permission, memberId],
            );
          for (const teamId of new Set(grants[permission].teamIds))
            await tx.client.query(
              `INSERT INTO ${relation(tx, 'channel_grants')} (channel_id,permission,team_id) VALUES ($1,$2,$3)`,
              [channel.id, permission, teamId],
            );
        }
        await tx.client.query(`UPDATE ${relation(tx, 'channels')} SET version=version+1 WHERE id=$1`, [channel.id]);
        await audit(tx, actor, channel.id, 'grants');
        const updated = channelRowSchema.parse(
          (await tx.client.query(`SELECT * FROM ${relation(tx, 'channels')} WHERE id=$1`, [channel.id])).rows[0],
        );
        return toChannel(tx, updated);
      });
    },
    authorize,
    authorizeWithin,
    /** The member acting, and the agent acting for them, after the agent permission limits (PRODUCT 11). */
    principal: resolvePrincipal,
    /**
     * A post target is chosen per post, never stored on the channel. It must suit the platform and pass the
     * target's live posting rules; preparing and publishing a variant each call this (PRODUCT 12).
     */
    async checkTarget(
      workspaceId: string,
      principal: ChannelPrincipal,
      channelId: string,
      target: Target | null,
      expected: ChannelExpectations = {},
    ): Promise<ValidationError[]> {
      const parsed = target === null ? null : targetSchema.parse(target);
      const { channel, account } = await authorize(workspaceId, principal, channelId, 'publish', expected);
      const shape = targetIssue(channel.platform, parsed);
      if (shape) return [{ path: ['target'], code: shape }];
      if (!parsed) return [];
      const adapter = adapterFor(channel.platform);
      if (!adapter.targetRules) return [{ path: ['target'], code: 'target-rules-unavailable' }];
      const access = await options.accounts.accessToken(workspaceId, account.id);
      if (access.account.generation !== channel.accountGeneration) throw new SocialError('account-reconnect-required');
      const rules = await adapter.targetRules(channel, parsed, access.token);
      const issues: ValidationError[] = [];
      if (!rules.postingAllowed) issues.push({ path: ['target'], code: 'target-posting-not-allowed' });
      const flairId = parsed.kind === 'subreddit' ? parsed.flairId : undefined;
      if (rules.flairRequired && !flairId) issues.push({ path: ['target', 'flairId'], code: 'flair-required' });
      if (flairId && !rules.flairIds.includes(flairId))
        issues.push({ path: ['target', 'flairId'], code: 'flair-not-allowed' });
      return issues;
    },
  };
}
export type SocialChannels = ReturnType<typeof createSocialChannels>;
