import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  humanActorSchema,
  lockAuthorization,
  resolveHuman,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { slackId, type SlackConfiguration } from './contracts.ts';
import { type SlackRuntime, type createSlackInstallations } from './installations.ts';
import { encryptSlackToken, storedCredentialSchema, type slackCredentialCipher } from './credentials.ts';
import { memberProvider } from './member-provider.ts';
import { requireSlackInstallationUse } from './installation-access.ts';
import { watchIntegrationRecommendations, type DefaultKnowledgeHook } from '@tulipfarm/integrations/authorization';
import { slackRecommendations } from './recommendations.ts';

const compatibility = commonCompatibility;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const challengeSchema = z.object({
  state_hash: z.string(),
  event_id: z.uuid(),
  installation_id: z.uuid(),
  generation: z.number().int(),
  app_id: slackId,
  team_id: slackId,
  slack_user_id: slackId,
  user_id: z.string(),
  membership_id: z.uuid(),
  session_id: z.string(),
  browser_hash: z.string(),
  nonce: z.string(),
  stage: z.enum([
    'identity',
    'identity-exchanging',
    'identity-proved',
    'operational',
    'operational-exchanging',
    'used',
  ]),
});
type Challenge = z.infer<typeof challengeSchema>;
type WorkspaceTransaction = Parameters<Parameters<SlackRuntime['transaction']>[2]>[0];
const identitySchema = z.object({
  id: z.uuid(),
  user_id: z.string(),
  membership_id: z.uuid(),
  state: z.enum(['consent-required', 'authorized', 'revoked']),
  authorized_at: z.date().nullable().optional(),
});
// Joined public/private channel history; DMs and group messages stay opt-in.
const knowledgeScopes = ['channels:history', 'groups:history'];

export function createSlackMemberLinking(options: {
  runtime: SlackRuntime;
  config: SlackConfiguration;
  cipher: ReturnType<typeof slackCredentialCipher>;
  installations: Pick<ReturnType<typeof createSlackInstallations>, 'route'>;
  fetcher?: typeof fetch;
  defaultKnowledge?: DefaultKnowledgeHook;
}) {
  const { runtime, config, cipher, installations } = options;
  const provider = memberProvider(config, options.fetcher);
  function linking() {
    if (!config.memberLinking) throw new Error('slack-linking-disabled');
    return config.memberLinking;
  }
  async function live(
    tx: WorkspaceTransaction,
    workspaceId: string,
    challenge: Pick<
      Challenge,
      'user_id' | 'membership_id' | 'installation_id' | 'generation' | 'app_id' | 'team_id' | 'slack_user_id'
    >,
  ) {
    await lockAuthorization(tx);
    await currentMember(tx, { kind: 'human', userId: challenge.user_id, membershipId: challenge.membership_id });
    await requireSlackInstallationUse(
      tx,
      { kind: 'human', userId: challenge.user_id, membershipId: challenge.membership_id },
      challenge.installation_id,
    );
    const local = await tx.client.query(
      `SELECT id FROM ${qualified(tx.schema, 'tf_slack_installations')} WHERE id=$1 AND generation=$2 AND app_id=$3 AND team_id=$4 AND state='active' FOR UPDATE`,
      [challenge.installation_id, challenge.generation, challenge.app_id, challenge.team_id],
    );
    const route = await installations.route(challenge.app_id, challenge.team_id);
    if (
      !local.rowCount ||
      route?.workspaceId !== workspaceId ||
      route.installationId !== challenge.installation_id ||
      route.generation !== challenge.generation ||
      challenge.app_id !== config.appId
    )
      throw new AccessDenied();
    if (
      (
        await tx.client.query(
          `SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_user_revocations')} WHERE installation_id=$1 AND generation=$2 AND slack_user_id=$3`,
          [challenge.installation_id, challenge.generation, challenge.slack_user_id],
        )
      ).rowCount
    )
      throw new AccessDenied();
  }
  async function transition(
    state: string,
    browser: string,
    expected: Challenge['stage'],
    next: Challenge['stage'],
    session: { userId: string; sessionId: string } | null,
    effect?: (tx: WorkspaceTransaction, c: Challenge) => Promise<void>,
  ) {
    const workspaceId = z.uuid().parse(state.split('.')[0]);
    return runtime.transaction(workspaceId, compatibility, async tx => {
      const challenge = challengeSchema
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${qualified(tx.schema, 'tf_slack_link_challenges')} WHERE state_hash=$1 AND expires_at>clock_timestamp()`,
              [hash(state)],
            )
          ).rows[0],
        );
      if (
        !challenge ||
        challenge.browser_hash !== hash(browser) ||
        (session && (challenge.user_id !== session.userId || challenge.session_id !== session.sessionId))
      )
        throw new AccessDenied();
      await live(tx, workspaceId, challenge);
      const updated = await tx.client.query(
        `UPDATE ${qualified(tx.schema, 'tf_slack_link_challenges')} SET stage=$3 WHERE state_hash=$1 AND stage=$2 AND expires_at>clock_timestamp() RETURNING state_hash`,
        [hash(state), expected, next],
      );
      if (!updated.rowCount) throw new AccessDenied();
      await effect?.(tx, challenge);
      return { workspaceId, challenge };
    });
  }
  async function begin(workspaceId: string, eventId: string, userId: string, sessionId: string) {
    const settings = linking();
    const state = `${workspaceId}.${randomBytes(32).toString('base64url')}`;
    const browser = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const challenge = await runtime.transaction(workspaceId, compatibility, async tx => {
      await lockAuthorization(tx);
      const actor = await resolveHuman(tx, userId);
      const event = z
        .object({
          installation_id: z.uuid(),
          generation: z.number().int(),
          app_id: slackId,
          team_id: slackId,
          slack_user_id: slackId,
        })
        .parse(
          (
            await tx.client.query(
              `SELECT e.installation_id,e.generation,i.app_id,i.team_id,e.payload->>'user' AS slack_user_id FROM ${qualified(tx.schema, 'tf_slack_events')} e JOIN ${qualified(tx.schema, 'tf_slack_installations')} i ON i.id=e.installation_id WHERE e.id=$1 AND e.disposition='held'`,
              [z.uuid().parse(eventId)],
            )
          ).rows[0],
        );
      const challenge: Challenge = {
        ...event,
        event_id: eventId,
        state_hash: hash(state),
        user_id: userId,
        membership_id: actor.membershipId,
        session_id: sessionId,
        browser_hash: hash(browser),
        nonce,
        stage: 'identity',
      };
      await live(tx, workspaceId, challenge);
      const identity = identitySchema
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${qualified(tx.schema, 'tf_slack_identities')} WHERE installation_id=$1 AND generation=$2 AND slack_user_id=$3`,
              [event.installation_id, event.generation, event.slack_user_id],
            )
          ).rows[0],
        );
      if (
        identity &&
        (identity.user_id !== userId || identity.membership_id !== actor.membershipId || identity.state === 'revoked')
      )
        throw new AccessDenied();
      await tx.client.query(
        `INSERT INTO ${qualified(tx.schema, 'tf_slack_link_challenges')} (state_hash,event_id,installation_id,generation,app_id,team_id,slack_user_id,user_id,membership_id,session_id,browser_hash,nonce,stage,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'identity',clock_timestamp()+interval '10 minutes')`,
        [
          challenge.state_hash,
          eventId,
          event.installation_id,
          event.generation,
          event.app_id,
          event.team_id,
          event.slack_user_id,
          userId,
          actor.membershipId,
          sessionId,
          challenge.browser_hash,
          nonce,
        ],
      );
      return challenge;
    });
    const url = new URL('https://slack.com/openid/connect/authorize');
    url.search = new URLSearchParams({
      response_type: 'code',
      scope: 'openid',
      client_id: config.clientId,
      redirect_uri: settings.identityRedirectUri,
      team: challenge.team_id,
      state,
      nonce,
    }).toString();
    return { url: url.href, browser };
  }
  async function proveIdentity(state: string, browser: string, code: string) {
    const { challenge } = await transition(state, browser, 'identity', 'identity-exchanging', null);
    const proof = await provider.identity(code, challenge.nonce);
    if (proof.teamId !== challenge.team_id || proof.userId !== challenge.slack_user_id) throw new AccessDenied();
    await transition(state, browser, 'identity-exchanging', 'identity-proved', null);
  }
  async function consent(state: string, browser: string, userId: string, sessionId: string) {
    const settings = linking();
    const { challenge } = await transition(
      state,
      browser,
      'identity-proved',
      'operational',
      { userId, sessionId },
      async (tx, c) => {
        const table = (name: string) => qualified(tx.schema, name);
        await tx.client.query(
          `INSERT INTO ${table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state) VALUES ($1,$2,$3,$4,$5,$6,'consent-required') ON CONFLICT DO NOTHING`,
          [randomUUID(), c.installation_id, c.generation, c.slack_user_id, c.user_id, c.membership_id],
        );
        const identity = identitySchema.parse(
          (
            await tx.client.query(
              `SELECT * FROM ${table('tf_slack_identities')} WHERE installation_id=$1 AND generation=$2 AND slack_user_id=$3`,
              [c.installation_id, c.generation, c.slack_user_id],
            )
          ).rows[0],
        );
        if (
          identity.user_id !== c.user_id ||
          identity.membership_id !== c.membership_id ||
          identity.state === 'revoked'
        )
          throw new AccessDenied();
        await tx.client.query(
          `INSERT INTO ${table('tf_slack_continuations')} (event_id,identity_id,state) VALUES ($1,$2,'consent-required') ON CONFLICT DO NOTHING`,
          [c.event_id, identity.id],
        );
        const continuation = await tx.client.query(
          `SELECT event_id FROM ${table('tf_slack_continuations')} WHERE event_id=$1 AND identity_id=$2 AND state<>'cancelled'`,
          [c.event_id, identity.id],
        );
        if (!continuation.rowCount) throw new AccessDenied();
      },
    );
    const url = new URL('https://slack.com/oauth/v2_user/authorize');
    url.search = new URLSearchParams({
      client_id: config.clientId,
      scope: settings.scopeApproval.userScopes.join(','),
      redirect_uri: settings.operationalRedirectUri,
      team: challenge.team_id,
      state,
      code_challenge: createHash('sha256').update(browser).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.href };
  }
  async function complete(state: string, browser: string, code: string, userId: string, sessionId: string) {
    const { challenge } = await transition(state, browser, 'operational', 'operational-exchanging', {
      userId,
      sessionId,
    });
    const proof = await provider.operational(code, browser);
    if (proof.teamId !== challenge.team_id || proof.userId !== challenge.slack_user_id) throw new AccessDenied();
    const target = z.uuid().safeParse(state.split('.')[0]);
    const automatic =
      target.success &&
      proof.scopes.some(scope => knowledgeScopes.includes(scope)) &&
      options.defaultKnowledge &&
      (await options.defaultKnowledge.enabled(target.data, userId))
        ? options.defaultKnowledge
        : undefined;
    let intent: string | null = null;
    const { workspaceId } = await transition(
      state,
      browser,
      'operational-exchanging',
      'used',
      { userId, sessionId },
      async (tx, c) => {
        const table = (name: string) => qualified(tx.schema, name);
        const identity = identitySchema.parse(
          (
            await tx.client.query(
              `SELECT * FROM ${table('tf_slack_identities')} WHERE installation_id=$1 AND generation=$2 AND slack_user_id=$3`,
              [c.installation_id, c.generation, c.slack_user_id],
            )
          ).rows[0],
        );
        if (identity.user_id !== userId || identity.membership_id !== c.membership_id || identity.state === 'revoked')
          throw new AccessDenied();
        const recommendations = await watchIntegrationRecommendations(tx, c.installation_id, () =>
          slackRecommendations(tx, c.installation_id),
        );
        const credential = encryptSlackToken(
          cipher,
          {
            workspaceId: z.uuid().parse(state.split('.')[0]),
            installationId: c.installation_id,
            generation: c.generation,
            kind: 'user',
            identityId: identity.id,
            membershipId: c.membership_id,
            slackUserId: c.slack_user_id,
          },
          proof.token,
          proof,
        );
        await tx.client.query(
          `UPDATE ${table('tf_slack_action_effects')} e SET state=CASE WHEN e.state='sending' THEN 'unknown' ELSE 'stale' END FROM ${table('tf_slack_actions')} a WHERE a.id=e.action_id AND a.identity_id=$1 AND e.state IN ('pending','retry','reauthorization-required','sending')`,
          [identity.id],
        );
        await tx.client.query(
          `UPDATE ${table('tf_slack_identities')} SET state='authorized',credential=$2,scopes=$3,authorized_at=clock_timestamp() WHERE id=$1`,
          [identity.id, credential, proof.scopes],
        );
        await tx.client.query(
          `UPDATE ${table('tf_slack_link_challenges')} SET stage='used' WHERE installation_id=$1 AND generation=$2 AND slack_user_id=$3 AND stage<>'used'`,
          [c.installation_id, c.generation, c.slack_user_id],
        );
        await tx.client.query(
          `UPDATE ${table('tf_slack_continuations')} SET state='dispatch-held' WHERE identity_id=$1 AND state='consent-required'`,
          [identity.id],
        );
        await recommendations();
        // Member operational consent is the enablement; installation alone and reauthorization of a linked identity are not.
        // The key is the Slack account (`team:user`, as Knowledge's slackAccountKey), so relinking the same account after a reinstall keeps its earlier policy and opt-out.
        if (automatic && identity.state === 'consent-required' && !identity.authorized_at) {
          const recorded = await automatic.record(tx, {
            product: 'slack',
            membershipId: c.membership_id,
            accountKey: `${c.team_id}:${c.slack_user_id}`,
            accountLabel: `@${c.slack_user_id}`,
          });
          if (recorded.created) intent = recorded.intentId;
        }
      },
    );
    if (automatic && intent) automatic.started?.(workspaceId, [intent]);
    return { workspaceId, eventId: challenge.event_id, state: 'dispatch-held', execution: 'disabled' };
  }
  async function unlink(workspaceId: string, userId: string) {
    await runtime.transaction(workspaceId, compatibility, async tx => {
      await lockAuthorization(tx);
      const actor = await resolveHuman(tx, userId);
      await tx.client.query(`SELECT id FROM ${qualified(tx.schema, 'tf_slack_installations')} FOR UPDATE`);
      const recommendations = await watchIntegrationRecommendations(tx, 'slack', () => slackRecommendations(tx));
      await tx.client.query(
        `UPDATE ${qualified(tx.schema, 'tf_slack_link_challenges')} SET stage='used' WHERE membership_id=$1 AND stage<>'used'`,
        [actor.membershipId],
      );
      const rows = await tx.client.query(
        `UPDATE ${qualified(tx.schema, 'tf_slack_identities')} SET state='revoked',credential=NULL WHERE membership_id=$1 RETURNING id`,
        [actor.membershipId],
      );
      for (const row of z.array(z.object({ id: z.uuid() })).parse(rows.rows))
        await tx.client.query(
          `UPDATE ${qualified(tx.schema, 'tf_slack_continuations')} SET state='cancelled' WHERE identity_id=$1`,
          [row.id],
        );
      await recommendations();
    });
    return { state: 'revoked', execution: 'disabled', providerRevocation: 'manual-required' };
  }
  async function status(workspaceId: string, eventId: string, userId: string) {
    return runtime.transaction(workspaceId, compatibility, async tx => {
      await lockAuthorization(tx);
      const actor = await resolveHuman(tx, userId);
      const row = z
        .object({
          state: z.enum(['consent-required', 'dispatch-held', 'cancelled']),
          user_id: z.string(),
          membership_id: z.uuid(),
          installation_id: z.uuid(),
          generation: z.number().int(),
          app_id: slackId,
          team_id: slackId,
          slack_user_id: slackId,
        })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT c.state,i.user_id,i.membership_id,i.installation_id,i.generation,s.app_id,s.team_id,i.slack_user_id FROM ${qualified(tx.schema, 'tf_slack_continuations')} c JOIN ${qualified(tx.schema, 'tf_slack_identities')} i ON i.id=c.identity_id JOIN ${qualified(tx.schema, 'tf_slack_installations')} s ON s.id=i.installation_id WHERE c.event_id=$1`,
              [z.uuid().parse(eventId)],
            )
          ).rows[0],
        );
      if (!row) return { state: 'unlinked', execution: 'disabled' };
      if (row.user_id !== userId || row.membership_id !== actor.membershipId) throw new AccessDenied();
      if (row.state !== 'cancelled') await live(tx, workspaceId, row);
      if (row.state !== 'cancelled') {
        const stored = storedCredentialSchema.safeParse(
          (
            await tx.client.query(
              `SELECT credential FROM ${qualified(tx.schema, 'tf_slack_identities')} WHERE installation_id=$1 AND generation=$2 AND slack_user_id=$3`,
              [row.installation_id, row.generation, row.slack_user_id],
            )
          ).rows[0]?.credential,
        );
        if (
          stored.success &&
          stored.data.rotation &&
          (stored.data.rotation.state === 'reconnect-required' ||
            (stored.data.rotation.state === 'ready' && stored.data.rotation.expiresAt <= Date.now()))
        )
          return { state: 'reconnect-required', execution: 'disabled' };
      }
      if (row.state === 'dispatch-held') {
        const delivery = z
          .object({ state: z.enum(['pending', 'sending', 'retry', 'sent', 'unknown', 'blocked']) })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT state FROM ${qualified(tx.schema, 'tf_slack_dm_events')} WHERE event_id=$1`,
                [eventId],
              )
            ).rows[0],
          );
        if (delivery) return { state: row.state, execution: delivery.state };
      }
      if (row.state === 'dispatch-held') {
        const delivery = z
          .object({ state: z.enum(['pending', 'sending', 'retry', 'sent', 'unknown', 'blocked']) })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT state FROM ${qualified(tx.schema, 'tf_slack_agent_turns')} WHERE event_id=$1`,
                [eventId],
              )
            ).rows[0],
          );
        if (delivery) return { state: row.state, execution: delivery.state };
        if (
          (
            await tx.client.query(
              `SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_agent_rejections')} WHERE event_id=$1`,
              [eventId],
            )
          ).rowCount
        )
          return { state: row.state, execution: 'blocked' };
      }
      if (row.state === 'dispatch-held') {
        const delivery = z
          .object({ state: z.enum(['pending', 'sending', 'retry', 'sent', 'unknown', 'blocked']) })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT state FROM ${qualified(tx.schema, 'tf_slack_default_turns')} WHERE event_id=$1`,
                [eventId],
              )
            ).rows[0],
          );
        if (delivery) return { state: row.state, execution: delivery.state };
      }
      return { state: row.state, execution: 'disabled' };
    });
  }
  async function recover(state: string, browser: string, session: { userId: string; sessionId: string } | null) {
    const workspaceId = z.uuid().parse(state.split('.')[0]);
    return runtime.transaction(workspaceId, compatibility, async tx => {
      const challenge = challengeSchema
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${qualified(tx.schema, 'tf_slack_link_challenges')} WHERE state_hash=$1`,
              [hash(state)],
            )
          ).rows[0],
        );
      if (
        !challenge ||
        challenge.browser_hash !== hash(browser) ||
        challenge.app_id !== config.appId ||
        (session && (session.userId !== challenge.user_id || session.sessionId !== challenge.session_id))
      )
        throw new AccessDenied();
      await tx.client.query(`SELECT id FROM ${qualified(tx.schema, 'tf_slack_installations')} WHERE id=$1 FOR UPDATE`, [
        challenge.installation_id,
      ]);
      await tx.client.query(
        `UPDATE ${qualified(tx.schema, 'tf_slack_link_challenges')} SET stage='used' WHERE state_hash=$1`,
        [hash(state)],
      );
      return { workspaceId, eventId: challenge.event_id };
    });
  }
  async function withPendingReadCredential<T>(
    workspaceId: string,
    eventId: string,
    actor: HumanActor,
    read: (input: {
      token: string;
      identity: {
        appId: string;
        teamId: string;
        userId: string;
        installationGeneration: number;
        distribution: 'internal' | 'marketplace';
      };
    }) => Promise<T>,
  ) {
    const settings = linking();
    const requester = humanActorSchema.parse(actor);
    return runtime.transaction(workspaceId, compatibility, async tx => {
      await lockAuthorization(tx);
      await currentMember(tx, requester);
      const row = z
        .object({
          id: z.uuid(),
          user_id: z.string(),
          membership_id: z.uuid(),
          installation_id: z.uuid(),
          generation: z.number().int(),
          app_id: slackId,
          team_id: slackId,
          slack_user_id: slackId,
          credential: z.unknown(),
          scopes: z.array(z.string()),
        })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT i.*,s.app_id,s.team_id FROM ${qualified(tx.schema, 'tf_slack_continuations')} c JOIN ${qualified(tx.schema, 'tf_slack_identities')} i ON i.id=c.identity_id JOIN ${qualified(tx.schema, 'tf_slack_installations')} s ON s.id=i.installation_id WHERE c.event_id=$1 AND c.state='dispatch-held' AND i.state='authorized'`,
              [z.uuid().parse(eventId)],
            )
          ).rows[0],
        );
      if (
        !row ||
        row.user_id !== requester.userId ||
        row.membership_id !== requester.membershipId ||
        settings.scopeApproval.userScopes.some(scope => !row.scopes.includes(scope))
      )
        throw new AccessDenied();
      await live(tx, workspaceId, row);
      // The installation lock fences unlink and provider revocation until this bounded read finishes.
      const fresh = z
        .object({ state: z.string(), credential: z.unknown() })
        .parse(
          (
            await tx.client.query(
              `SELECT state,credential FROM ${qualified(tx.schema, 'tf_slack_identities')} WHERE id=$1`,
              [row.id],
            )
          ).rows[0],
        );
      if (fresh.state !== 'authorized') throw new AccessDenied();
      const token = cipher.decrypt(
        {
          workspaceId,
          installationId: row.installation_id,
          generation: row.generation,
          kind: 'user',
          identityId: row.id,
          membershipId: row.membership_id,
          slackUserId: row.slack_user_id,
        },
        fresh.credential,
      );
      return read({
        token,
        identity: {
          appId: row.app_id,
          teamId: row.team_id,
          userId: row.slack_user_id,
          installationGeneration: row.generation,
          distribution: settings.distribution,
        },
      });
    });
  }
  return { begin, proveIdentity, consent, complete, unlink, status, recover, withPendingReadCredential };
}
