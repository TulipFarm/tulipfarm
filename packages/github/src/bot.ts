import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
} from '@tulipfarm/access';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { createGitHubAppProvider } from './app-provider.ts';
import type { AccountRuntime, GitHubCredential } from './accounts.ts';
import { botGrantInputSchema, botGrantListSchema, type BotGrantList, type GitHubWrite } from './batch-contracts.ts';

export type GitHubBot = {
  /** The member's credential with the token and identity of the App bot, valid for one repository. */
  credential(member: GitHubCredential, owner: string, repo: string): Promise<GitHubCredential>;
};

/** The `owner/repo` the bot would write to, or null when the action may not run as the bot. */
export function botRepository(action: GitHubWrite): string | null {
  if (
    action.kind.startsWith('project.') ||
    action.kind.startsWith('repository.') ||
    action.kind === 'pull.create-fork' ||
    !('owner' in action) ||
    !('repo' in action)
  )
    return null;
  return `${action.owner}/${action.repo}`.toLowerCase();
}

/** True when the member holds a bot grant for the repository of every action. */
export async function botGranted(tx: AuthorizationTransaction, membershipId: string, actions: readonly GitHubWrite[]) {
  const repositories = actions.map(botRepository);
  if (!repositories.length || repositories.some(value => value === null)) return false;
  const granted = await tx.client.query(
    `SELECT count(DISTINCT repository)::integer AS count FROM ${qualified(tx.schema, 'tf_github_bot_grants')} WHERE membership_id=$1 AND repository=ANY($2::text[])`,
    [membershipId, repositories],
  );
  return z.number().parse(granted.rows[0]?.count) === new Set(repositories).size;
}

export function githubBot(env: NodeJS.ProcessEnv = process.env, fetcher?: typeof fetch): GitHubBot | null {
  const key = env.GITHUB_APP_PRIVATE_KEY;
  if (!key) return null;
  let provider: { app: ReturnType<typeof createGitHubAppProvider>; slug: string } | undefined;
  // Built on first use so a bad bot setting fails bot writes only, not member writes.
  const setup = () => {
    const { GITHUB_WEBHOOK_APP_ID: appId, GITHUB_OAUTH_CLIENT_ID: clientId, GITHUB_APP_SLUG: slug } = env;
    if (!appId || !clientId || !slug)
      throw new Error(
        'GITHUB_APP_PRIVATE_KEY requires GITHUB_WEBHOOK_APP_ID, GITHUB_OAUTH_CLIENT_ID and GITHUB_APP_SLUG',
      );
    return (provider ??= {
      app: createGitHubAppProvider({
        appId,
        clientId,
        privateKey: createPrivateKey(key.replaceAll('\\n', '\n')),
        ...(fetcher ? { fetcher } : {}),
      }),
      slug,
    });
  };
  let identity: Promise<{ id: string; login: string }> | undefined;
  return {
    async credential(member, owner, repo) {
      const { app, slug } = setup();
      const accessToken = await app.repositoryWriteToken(owner, repo);
      identity ??= app.botUser(slug, accessToken).catch(error => {
        identity = undefined;
        throw error;
      });
      return { ...member, accessToken, identity: await identity, scopes: [], app: true };
    },
  };
}

export function createGitHubBotGrants(runtime: AccountRuntime, env: NodeJS.ProcessEnv = process.env) {
  const run = <T>(
    workspaceId: string,
    userId: string,
    manage: boolean,
    operation: (tx: AuthorizationTransaction, membershipId: string, admin: boolean) => Promise<T>,
  ) =>
    runtime.transaction(z.uuid().parse(workspaceId).toLowerCase(), commonCompatibility, async tx => {
      await lockAuthorization(tx, manage ? 'write' : 'read');
      const actor = await resolveHuman(tx, userId);
      const admin = (await currentMember(tx, actor)).role === 'admin';
      if (manage && !admin) throw new AccessDenied();
      return operation(tx, actor.membershipId, admin);
    });
  const table = (tx: AuthorizationTransaction) => qualified(tx.schema, 'tf_github_bot_grants');
  const members = (tx: AuthorizationTransaction) =>
    `${qualified(tx.schema, 'tf_workspace_member_accounts')} a JOIN ${qualified(tx.schema, 'tf_memberships')} m ON m.id=a.membership_id AND m.removed_at IS NULL`;
  const list = (tx: AuthorizationTransaction, membershipId: string, admin: boolean): Promise<BotGrantList> =>
    tx.client
      .query(
        `SELECT a.member_id AS "memberId", g.repository FROM ${table(tx)} g JOIN ${members(tx)} ON a.membership_id=g.membership_id WHERE $2 OR g.membership_id=$1 ORDER BY g.repository, a.member_id`,
        [membershipId, admin],
      )
      .then(result =>
        botGrantListSchema.parse({
          configured: Boolean(env.GITHUB_APP_PRIVATE_KEY),
          manage: admin,
          grants: result.rows,
        }),
      );
  return {
    list: (workspaceId: string, userId: string) => run(workspaceId, userId, false, list),
    add: (workspaceId: string, userId: string, input: unknown) =>
      run(workspaceId, userId, true, async (tx, membershipId, admin) => {
        const grant = botGrantInputSchema.parse(input);
        await tx.client.query(
          `INSERT INTO ${table(tx)} (membership_id,repository,granted_by) SELECT m.id,$2,$3 FROM ${members(tx)} WHERE a.member_id=$1 ON CONFLICT DO NOTHING`,
          [grant.memberId, grant.repository, membershipId],
        );
        return list(tx, membershipId, admin);
      }),
    remove: (workspaceId: string, userId: string, input: unknown) =>
      run(workspaceId, userId, true, async (tx, membershipId, admin) => {
        const grant = botGrantInputSchema.parse(input);
        await tx.client.query(
          `DELETE FROM ${table(tx)} g USING ${qualified(tx.schema, 'tf_workspace_member_accounts')} a WHERE a.membership_id=g.membership_id AND a.member_id=$1 AND g.repository=$2`,
          [grant.memberId, grant.repository],
        );
        return list(tx, membershipId, admin);
      }),
  };
}
