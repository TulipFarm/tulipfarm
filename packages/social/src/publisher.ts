import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  lockAuthorization,
  requireNoMcpDerived,
  sourceDependencySchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { observeDependency } from '@tulipfarm/observability';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type {
  AwaitStep,
  FailurePhase,
  MutateStep,
  ReconcileInput,
  ReconcileResult,
  SocialPlatformAdapter,
  Step,
  StepInput,
  TokenSet,
} from './adapter.ts';
import { socialCompatibility, type SocialAccounts, type SocialRuntime } from './accounts.ts';
import { batchDigest } from './batch-digest.ts';
import type { AuthorizedChannel, SocialChannels } from './channels.ts';
import {
  channelKindSchema,
  engagementPolicySchema,
  originSchema,
  platformContentSchema,
  platformRefsSchema,
  platformSchema,
  reviewChoiceEntrySchema,
  settleCommandSchema,
  stepKindSchema,
  targetSchema,
  temporaryBlockedReasons,
  tiktokReviewChoiceIssues,
  tiktokReviewChoicesSchema,
  variantCommandSchema,
  variantSchema,
  variantStateSchema,
  variantStepSchema,
  type BlockedReason,
  type Channel,
  type Platform,
  type PlatformRefs,
  type StepKind,
  type Variant,
  type VariantStep,
} from './contracts.ts';
import { SocialError } from './credentials.ts';
import { requireBoundMedia, type MediaGrant } from './media.ts';
import { createOriginCheck, type WorkflowGrantCheck } from './origin.ts';
import type { SourceCheck } from './posts.ts';

/** How long a claimed mutating step may run before the sweep treats its outcome as unknown (TECH). */
export const sendingLeaseSeconds = 120;
/** A variant still blocked this long after `dueAt` is cancelled (PRODUCT 25). */
export const blockedLifetimeMs = 7 * 24 * 60 * 60 * 1000;
/** Failures that the platform reports before a request is sent are retried this many times, then fail. */
export const beforeSendAttemptLimit = 5;
export const rateLimitRecheckSeconds = 15 * 60;
export const awaitBackoffSeconds = { minimum: 10, maximum: 5 * 60 } as const;
export const reconcileBackoffSeconds = { minimum: 60, maximum: 6 * 60 * 60 } as const;
/** FORMAT daily caps: the capped step kind and its limit in 24 hours. YouTube's project quota is counted per workspace. */
export const dailyCaps: Partial<Record<Platform, { step: StepKind; limit: number; scope: 'channel' | 'platform' }>> = {
  instagram: { step: 'publish-container', limit: 100, scope: 'channel' },
  threads: { step: 'publish-container', limit: 250, scope: 'channel' },
  youtube: { step: 'upload-video', limit: 100, scope: 'platform' },
};
const sweepBatch = 50;
const stepsPerVariant = 16;

/** Thrown by `StepInput.mediaUrl` when no pull URL can be issued; nothing was sent, and the variant is blocked. */
export class MediaUrlUnavailable extends Error {
  readonly phase: FailurePhase = 'before-send';
  constructor() {
    super('Social media URL unavailable');
    this.name = 'MediaUrlUnavailable';
  }
}

/** Issues a short-lived pull URL for one bound File of a claimed step (TECH, Media). */
export type MediaUrlSigner = (grant: MediaGrant) => Promise<URL>;

const uuid = z.uuid();
const platformPostIdSchema = z.string().min(1).max(256);
const permalinkSchema = z.url().max(2048);
const contextSchema = z.object({
  id: z.uuid(),
  post_id: z.uuid(),
  revision: z.number().int().positive(),
  channel_id: z.uuid(),
  channel_version: z.number().int().positive(),
  target: targetSchema.nullable(),
  content: platformContentSchema,
  publish_at: z.date().nullable(),
  due_at: z.date().nullable(),
  state: variantStateSchema,
  step: variantStepSchema.nullable(),
  blocked_reason: z.string().nullable(),
  recheck_at: z.date().nullable(),
  attempt_id: z.uuid().nullable(),
  next_attempt_at: z.date().nullable(),
  platform_refs: z.record(z.string(), z.string()),
  platform_post_id: z.string().nullable(),
  permalink: z.string().nullable(),
  origin: originSchema,
  content_digest: z.string(),
  sources: z.object({ dependencies: z.array(sourceDependencySchema) }),
  mcp_derived: z.boolean(),
  private_task_derived: z.boolean(),
  revision_review_choices: z.array(reviewChoiceEntrySchema),
  decision_id: z.uuid().nullable(),
  decision: z.enum(['approve', 'reject']).nullable(),
  batch_digest: z.string().nullable(),
  decision_review_choices: z.array(z.object({ variantId: z.uuid(), values: z.unknown() })).nullable(),
  sponsor_membership_id: z.uuid().nullable(),
  platform: platformSchema,
  channel_removed: z.boolean(),
  db_now: z.date(),
});
type Context = z.infer<typeof contextSchema> & { receipts: ReceiptRow[] };
const receiptRowSchema = z.object({
  id: z.uuid(),
  variant_id: z.uuid(),
  revision: z.number().int().positive(),
  decision_id: z.uuid(),
  step: stepKindSchema,
  attempt_id: z.uuid(),
  status: z.enum(['executing', 'succeeded', 'failed', 'outcome-unknown']),
  started_at: z.date(),
  settled_at: z.date().nullable(),
  platform_refs: z.record(z.string(), z.string()),
  platform_post_id: z.string().nullable(),
  platform_request_id: z.string().nullable(),
  error_class: z.string().nullable(),
  error_code: z.string().nullable(),
});
type ReceiptRow = z.infer<typeof receiptRowSchema>;

type Blocked = { blocked: BlockedReason };
type Skip = { skip: true };
type Passed = { sponsor: HumanActor; authorized: AuthorizedChannel };
type Ready = Passed & { token: TokenSet };

const iso = (value: Date | null) => (value === null ? null : value.toISOString());
const clamp = (value: number, bounds: { minimum: number; maximum: number }) =>
  Math.min(bounds.maximum, Math.max(bounds.minimum, Math.round(value)));
/** A platform code safe to store: never a response body or a token. */
const safeCode = (value: unknown) =>
  typeof value === 'string' && /^[a-z0-9._-]{1,64}$/i.test(value) ? value : 'platform-error';
const phaseOf = (error: unknown): FailurePhase =>
  typeof error === 'object' && error !== null && 'phase' in error && error.phase === 'before-send'
    ? 'before-send'
    : 'after-send';
const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
const isBlocked = (value: object): value is Blocked => 'blocked' in value;
const isSkip = (value: object): value is Skip => 'skip' in value;
/** Stable for every request about one step of a variant, so a platform can deduplicate it. */
const idempotencyKey = (variantId: string, step: StepKind | 'await') => `${variantId}:${step}`;

/** The channel check's refusals as a blocked reason; a transient account state is retried later. */
function blockedFor(error: unknown): Blocked | Skip {
  if (error instanceof AccessDenied) return { blocked: 'grant-removed' };
  if (error instanceof SocialError) {
    if (error.code === 'channel-conflict' || error.code === 'channel-unavailable')
      return { blocked: 'channel-changed' };
    if (error.code === 'account-reconnect-required' || error.code === 'account-conflict')
      return { blocked: 'account-reconnect' };
    if (error.code === 'account-unavailable' || error.code === 'platform-unavailable') return { skip: true };
  }
  throw error;
}

/**
 * The step sweep and the commands on a variant once it is approved (PRODUCT 22–26). Each variant is moved in its
 * own transactions, timed by the database clock, and a mutating step is sent at most once.
 */
export function createSocialPublisher(options: {
  runtime: SocialRuntime;
  accounts: Pick<SocialAccounts, 'accessToken' | 'tokenRejected'>;
  channels: Pick<SocialChannels, 'authorizeWithin' | 'checkTarget'>;
  adapters: Partial<Record<Platform, SocialPlatformAdapter>>;
  /** The chat source check, `requireDraftSources` in the composition. */
  requireSources: SourceCheck;
  workflowGrant?: WorkflowGrantCheck;
  mediaUrl?: MediaUrlSigner;
}) {
  const originCheck = createOriginCheck(options.workflowGrant ? { workflowGrant: options.workflowGrant } : {});
  const relation = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_social_${name}`);
  const adapterFor = (platform: Platform) => {
    const adapter = options.adapters[platform];
    return adapter && adapter.platform === platform ? adapter : null;
  };
  async function transaction<T>(workspaceId: string, operation: (tx: AuthorizationTransaction) => Promise<T>) {
    return options.runtime.transaction(uuid.parse(workspaceId), socialCompatibility, async tx => {
      await lockAuthorization(tx, 'read');
      return operation(tx);
    });
  }
  async function audit(tx: AuthorizationTransaction, actor: HumanActor, id: string, operation: string) {
    await tx.client.query(
      `INSERT INTO ${qualified(tx.schema, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,$3,$4)`,
      [randomUUID(), actor.membershipId, `social-post.${operation}`, id],
    );
  }
  const observe = <T>(call: () => Promise<T>) => observeDependency('social', 'request', call);

  async function load(tx: AuthorizationTransaction, variantId: string, lock: 'none' | 'wait' | 'skip') {
    const suffix = lock === 'none' ? '' : lock === 'wait' ? ' FOR UPDATE OF v' : ' FOR UPDATE OF v SKIP LOCKED';
    const row = contextSchema.optional().parse(
      (
        await tx.client.query(
          `SELECT v.id,v.post_id,v.revision,v.channel_id,v.channel_version,v.target,v.content,v.publish_at,v.due_at,v.state,
                  v.step,v.blocked_reason,v.recheck_at,v.attempt_id,v.next_attempt_at,v.platform_refs,v.platform_post_id,
                  v.permalink,p.origin,r.content_digest,r.sources,r.mcp_derived,r.private_task_derived,
                  r.review_choices AS revision_review_choices,d.id AS decision_id,d.decision,d.batch_digest,
                  d.review_choices AS decision_review_choices,d.sponsor_membership_id,c.platform,
                  c.removed_at IS NOT NULL AS channel_removed,clock_timestamp() AS db_now
             FROM ${relation(tx, 'variants')} v
             JOIN ${relation(tx, 'posts')} p ON p.id=v.post_id
             JOIN ${relation(tx, 'revisions')} r ON r.post_id=v.post_id AND r.number=v.revision
             JOIN ${relation(tx, 'channels')} c ON c.id=v.channel_id
             LEFT JOIN ${relation(tx, 'decisions')} d ON d.post_id=v.post_id AND d.revision=v.revision
            WHERE v.id=$1${suffix}`,
          [uuid.parse(variantId)],
        )
      ).rows[0],
    );
    if (!row) return null;
    const receipts = z.array(receiptRowSchema).parse(
      (
        await tx.client.query(
          `SELECT id,variant_id,revision,decision_id,step,attempt_id,status,started_at,settled_at,platform_refs,
                  platform_post_id,platform_request_id,error_class,error_code
             FROM ${relation(tx, 'receipts')} WHERE variant_id=$1 ORDER BY started_at,id`,
          [row.id],
        )
      ).rows,
    );
    return { ...row, receipts } satisfies Context;
  }

  /** The variant as FORMAT describes it, with its receipts (PRODUCT 26). */
  function toVariant(context: Context): Variant {
    return variantSchema.parse({
      id: context.id,
      postId: context.post_id,
      revision: context.revision,
      channelId: context.channel_id,
      channelVersion: context.channel_version,
      target: context.target,
      content: context.content,
      publishAt: iso(context.publish_at),
      dueAt: iso(context.due_at),
      state: context.state,
      step: context.step,
      blockedReason: context.blocked_reason,
      recheckAt: iso(context.recheck_at),
      platformRefs: context.platform_refs,
      platformPostId: context.platform_post_id,
      permalink: context.permalink,
      receipts: context.receipts.map(receipt => ({
        id: receipt.id,
        variantId: receipt.variant_id,
        revision: receipt.revision,
        decisionId: receipt.decision_id,
        step: receipt.step,
        attemptId: receipt.attempt_id,
        status: receipt.status,
        startedAt: receipt.started_at.toISOString(),
        settledAt: iso(receipt.settled_at),
        platformRefs: receipt.platform_refs,
        platformPostId: receipt.platform_post_id,
        platformRequestId: receipt.platform_request_id,
        error: receipt.error_class === null ? null : { class: receipt.error_class, code: receipt.error_code },
      })),
    });
  }

  /**
   * Every check that the database can answer, for the variant's sponsor, before a mutating step (PRODUCT 22): the
   * origin, the channel `publish` grant at the approved channel version and the account generation, the sources,
   * the media, the decision binding and the daily cap.
   */
  async function databaseChecks(tx: AuthorizationTransaction, context: Context): Promise<Passed | Blocked | Skip> {
    if (context.decision !== 'approve' || !context.decision_id) return { blocked: 'review-choices-changed' };
    const origin = await originCheck(tx, context.origin, context.sponsor_membership_id);
    if ('blocked' in origin) return origin;
    const { sponsor } = origin;
    if (context.channel_removed) return { blocked: 'channel-changed' };
    let authorized: AuthorizedChannel;
    try {
      authorized = await options.channels.authorizeWithin(tx, sponsor, context.channel_id, 'publish', {
        channelVersion: context.channel_version,
      });
    } catch (error) {
      return blockedFor(error);
    }
    if (context.mcp_derived || context.private_task_derived) return { blocked: 'source-lost' };
    try {
      await requireNoMcpDerived(tx, context.sources.dependencies);
      await options.requireSources(tx, sponsor, context.sources.dependencies);
    } catch (error) {
      if (error instanceof AccessDenied) return { blocked: 'source-lost' };
      throw error;
    }
    try {
      await requireBoundMedia(tx, sponsor, context.content.media);
    } catch (error) {
      if (error instanceof SocialError && (error.code === 'media-changed' || error.code === 'media-unreadable'))
        return { blocked: error.code };
      throw error;
    }
    const choices = (context.decision_review_choices ?? []) as Parameters<typeof batchDigest>[1];
    if (batchDigest(context.content_digest, choices) !== context.batch_digest)
      return { blocked: 'review-choices-changed' };
    if (await capReached(tx, context)) return { blocked: 'daily-cap' };
    return { sponsor, authorized };
  }

  /** Receipts of the capped step in the last 24 hours that may have reached the platform. */
  async function capReached(tx: AuthorizationTransaction, context: Context) {
    const cap = dailyCaps[context.platform];
    if (!cap) return false;
    const count = z.object({ n: z.number().int() }).parse(
      (
        await tx.client.query(
          `SELECT count(*)::integer AS n FROM ${relation(tx, 'receipts')} r
             JOIN ${relation(tx, 'variants')} v ON v.id=r.variant_id
             JOIN ${relation(tx, 'channels')} c ON c.id=v.channel_id
            WHERE r.step=$1 AND r.status<>'failed' AND r.started_at>clock_timestamp()-interval '24 hours'
              AND (($2::text='channel' AND v.channel_id=$3) OR ($2::text='platform' AND c.platform=$4))`,
          [cap.step, cap.scope, context.channel_id, context.platform],
        )
      ).rows[0],
    ).n;
    return count >= cap.limit;
  }

  /** The recheck time of a temporary reason: the cap's oldest counted receipt plus 24 hours, or 15 minutes. */
  async function recheckSeconds(tx: AuthorizationTransaction, context: Context, reason: BlockedReason) {
    if (!temporaryBlockedReasons.has(reason)) return null;
    const cap = dailyCaps[context.platform];
    if (reason !== 'daily-cap' || !cap) return rateLimitRecheckSeconds;
    const row = z.object({ seconds: z.number().nullable() }).parse(
      (
        await tx.client.query(
          `SELECT EXTRACT(EPOCH FROM min(r.started_at)+interval '24 hours'-clock_timestamp())::float8 AS seconds
             FROM ${relation(tx, 'receipts')} r
             JOIN ${relation(tx, 'variants')} v ON v.id=r.variant_id
             JOIN ${relation(tx, 'channels')} c ON c.id=v.channel_id
            WHERE r.step=$1 AND r.status<>'failed' AND r.started_at>clock_timestamp()-interval '24 hours'
              AND (($2::text='channel' AND v.channel_id=$3) OR ($2::text='platform' AND c.platform=$4))`,
          [cap.step, cap.scope, context.channel_id, context.platform],
        )
      ).rows[0],
    );
    return Math.max(1, Math.ceil(row.seconds ?? rateLimitRecheckSeconds));
  }

  /** Moves a waiting variant to `blocked`; `processing` and `scheduled` both may (FORMAT). */
  async function block(tx: AuthorizationTransaction, context: Context, reason: BlockedReason) {
    const seconds = await recheckSeconds(tx, context, reason);
    await tx.client.query(
      `UPDATE ${relation(tx, 'variants')} SET state='blocked',blocked_reason=$2,
              recheck_at=CASE WHEN $3::float8 IS NULL THEN NULL ELSE clock_timestamp()+make_interval(secs=>$3::float8) END
        WHERE id=$1`,
      [context.id, reason, seconds],
    );
  }

  /**
   * The checks that need the platform, for the sponsor: a usable token for the bound account, the target's live
   * rules (PRODUCT 12) and, for TikTok, the review choices the person made against the creator's current fields.
   */
  async function platformChecks(
    workspaceId: string,
    context: Context,
    adapter: SocialPlatformAdapter,
    passed: Passed,
  ): Promise<Ready | Blocked | Skip> {
    const { sponsor, authorized } = passed;
    let token: TokenSet;
    let tier;
    try {
      const access = await options.accounts.accessToken(workspaceId, authorized.account.id);
      if (access.account.generation !== authorized.channel.accountGeneration) return { blocked: 'account-reconnect' };
      token = access.token;
      tier = access.app.accessTier;
    } catch (error) {
      return blockedFor(error);
    }
    const platformFailure = async (error: unknown): Promise<Blocked | Skip> => {
      if (error instanceof AccessDenied || error instanceof SocialError) return blockedFor(error);
      const kind = adapter.classify(asError(error), 'before-send');
      if (kind === 'rate-limited') return { blocked: 'rate-limited' };
      if (kind === 'reconnect') {
        await options.accounts.tokenRejected(workspaceId, authorized.account.id, authorized.account.generation);
        return { blocked: 'account-reconnect' };
      }
      return { skip: true };
    };
    try {
      const issues = await options.channels.checkTarget(workspaceId, sponsor, context.channel_id, context.target, {
        channelVersion: context.channel_version,
      });
      if (issues.length) return { blocked: 'target-rules-changed' };
    } catch (error) {
      return platformFailure(error);
    }
    if (context.platform === 'tiktok') {
      const entry = context.revision_review_choices.find(item => item.variantId === context.id);
      const values = tiktokReviewChoicesSchema.safeParse(
        context.decision_review_choices?.find(item => item.variantId === context.id)?.values,
      );
      let fields;
      try {
        fields = adapter.reviewChoices ? await adapter.reviewChoices(authorized.channel, token) : null;
      } catch (error) {
        return platformFailure(error);
      }
      const required = new Set(entry?.required ?? []);
      if (
        !fields ||
        !values.success ||
        fields.length !== required.size ||
        fields.some(field => !required.has(field)) ||
        tiktokReviewChoiceIssues(values.data, tier).length
      )
        return { blocked: 'review-choices-changed' };
    }
    return { ...passed, token };
  }

  function stepInput(
    context: Context,
    adapter: SocialPlatformAdapter,
    channel: Channel,
    token: TokenSet,
    attemptId: string,
    kind: StepKind | 'await',
  ): StepInput {
    return {
      variant: toVariant(context),
      channel,
      token,
      attemptId,
      idempotencyKey: idempotencyKey(context.id, kind === 'await' ? (context.receipts.at(-1)?.step ?? kind) : kind),
      platformRefs: context.platform_refs,
      async mediaUrl(fileId) {
        const item = context.content.media.find(media => media.fileId === fileId);
        if (!item || !options.mediaUrl || kind === 'await') throw new MediaUrlUnavailable();
        return options.mediaUrl({
          variantId: context.id,
          attemptId,
          step: kind,
          fileId,
          contentDigest: item.contentDigest,
          expiresAt: new Date(Date.now() + adapter.mediaUrlTtlSeconds * 1000),
        });
      },
    };
  }

  /** The step the variant is at in its adapter's plan, or null when the stored step no longer matches it. */
  function planned(context: Context, adapter: SocialPlatformAdapter) {
    const plan: Step[] = adapter.plan(toVariant(context));
    const index = context.step?.index ?? 0;
    const step = plan[index];
    if (!step || (context.step && context.step.kind !== step.kind)) return null;
    return { plan, index, step };
  }
  const nextStep = (plan: Step[], index: number): VariantStep | null => {
    const step = plan[index + 1];
    return step ? { index: index + 1, kind: step.kind } : null;
  };

  async function unknown(tx: AuthorizationTransaction, id: string) {
    await tx.client.query(
      `UPDATE ${relation(tx, 'variants')} SET state='outcome-unknown',next_attempt_at=clock_timestamp()+interval '60 seconds'
        WHERE id=$1`,
      [id],
    );
  }
  async function settleReceipt(
    tx: AuthorizationTransaction,
    receiptId: string,
    status: 'succeeded' | 'failed' | 'outcome-unknown',
    fields: { refs?: PlatformRefs; platformPostId?: string | null; error?: { class: string; code: string } } = {},
  ) {
    await tx.client.query(
      `UPDATE ${relation(tx, 'receipts')} SET status=$2,settled_at=clock_timestamp(),platform_refs=$3,platform_post_id=$4,
              error_class=$5,error_code=$6
        WHERE id=$1 AND status='executing'`,
      [
        receiptId,
        status,
        JSON.stringify(fields.refs ?? {}),
        fields.platformPostId ?? null,
        fields.error?.class ?? null,
        fields.error?.code ?? null,
      ],
    );
  }

  /** A mutating step: every check, then a receipt and `sending`, then one adapter call, then the settlement. */
  async function mutate(workspaceId: string, variantId: string, expected: Context, adapter: SocialPlatformAdapter) {
    const first = await transaction(workspaceId, async tx => {
      const context = await load(tx, variantId, 'skip');
      if (!context || !sameStep(context, expected) || !due(context)) return null;
      const result = await databaseChecks(tx, context);
      if (isBlocked(result)) await block(tx, context, result.blocked);
      return { context, result };
    });
    if (!first || !('sponsor' in first.result)) return;
    const ready = await platformChecks(workspaceId, first.context, adapter, first.result);
    if (isSkip(ready)) return;
    const claimed = await transaction(workspaceId, async tx => {
      const context = await load(tx, variantId, 'skip');
      if (!context || !sameStep(context, expected) || !due(context)) return null;
      const target = planned(context, adapter);
      if (!target || target.step.kind === 'await') {
        if (context.state === 'processing') await unknown(tx, context.id);
        return null;
      }
      if (isBlocked(ready)) {
        await block(tx, context, ready.blocked);
        return null;
      }
      const checked = await databaseChecks(tx, context);
      if (isSkip(checked)) return null;
      if (isBlocked(checked)) {
        await block(tx, context, checked.blocked);
        return null;
      }
      const attemptId = randomUUID();
      const receiptId = randomUUID();
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'receipts')} (id,variant_id,revision,decision_id,step,attempt_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [receiptId, context.id, context.revision, context.decision_id, target.step.kind, attemptId],
      );
      const step = { index: target.index, kind: target.step.kind };
      await tx.client.query(
        `UPDATE ${relation(tx, 'variants')} SET state='sending',step=$2,attempt_id=$3,
                next_attempt_at=clock_timestamp()+make_interval(secs=>$4)
          WHERE id=$1`,
        [context.id, JSON.stringify(step), attemptId, sendingLeaseSeconds],
      );
      const sent = await load(tx, context.id, 'none');
      return {
        context: sent!,
        plan: target.plan,
        step: target.step,
        attemptId,
        receiptId,
        channel: checked.authorized,
      };
    });
    if (!claimed || isBlocked(ready)) return;
    const input = stepInput(
      claimed.context,
      adapter,
      claimed.channel.channel,
      ready.token,
      claimed.attemptId,
      claimed.step.kind,
    );
    let outcome: { result: Awaited<ReturnType<SocialPlatformAdapter['mutate']>> } | { error: unknown };
    try {
      outcome = { result: await observe(() => adapter.mutate(claimed.step as MutateStep, input)) };
    } catch (error) {
      outcome = { error };
    }
    let reconnect = false;
    await transaction(workspaceId, async tx => {
      const context = await load(tx, variantId, 'wait');
      if (!context || context.attempt_id !== claimed.attemptId) return;
      if (context.state === 'outcome-unknown') {
        // The lease expired while the step ran: only a confirmed post or new references settle it now.
        if ('result' in outcome && outcome.result.kind === 'published') {
          const id = platformPostIdSchema.safeParse(outcome.result.platformPostId);
          if (id.success)
            await tx.client.query(
              `UPDATE ${relation(tx, 'variants')} SET state='published',platform_post_id=$2,permalink=$3 WHERE id=$1`,
              [context.id, id.data, permalinkSchema.safeParse(outcome.result.permalink).data ?? null],
            );
        } else if ('result' in outcome && outcome.result.kind === 'done') {
          const refs = platformRefsSchema.safeParse(outcome.result.platformRefs);
          if (refs.success)
            await tx.client.query(
              `UPDATE ${relation(tx, 'variants')} SET platform_refs=platform_refs||$2::jsonb WHERE id=$1`,
              [context.id, JSON.stringify(refs.data)],
            );
        }
        return;
      }
      if (context.state !== 'sending') return;
      if ('result' in outcome) {
        const result = outcome.result;
        if (result.kind === 'done') {
          const refs = platformRefsSchema.safeParse(result.platformRefs);
          if (!refs.success) {
            await settleReceipt(tx, claimed.receiptId, 'outcome-unknown', {
              error: { class: 'unknown', code: 'invalid-platform-refs' },
            });
            await unknown(tx, context.id);
            return;
          }
          await settleReceipt(tx, claimed.receiptId, 'succeeded', { refs: refs.data });
          const next = nextStep(claimed.plan, context.step?.index ?? 0);
          await tx.client.query(
            `UPDATE ${relation(tx, 'variants')} SET platform_refs=platform_refs||$2::jsonb WHERE id=$1`,
            [context.id, JSON.stringify(refs.data)],
          );
          if (next)
            await tx.client.query(
              `UPDATE ${relation(tx, 'variants')} SET state='processing',step=$2,next_attempt_at=clock_timestamp() WHERE id=$1`,
              [context.id, JSON.stringify(next)],
            );
          // A final step that returns only references cannot say whether a post exists.
          else await unknown(tx, context.id);
          return;
        }
        if (result.kind === 'published') {
          const id = platformPostIdSchema.safeParse(result.platformPostId);
          if (!id.success) {
            await settleReceipt(tx, claimed.receiptId, 'outcome-unknown', {
              error: { class: 'unknown', code: 'invalid-platform-post-id' },
            });
            await unknown(tx, context.id);
            return;
          }
          await settleReceipt(tx, claimed.receiptId, 'succeeded', { platformPostId: id.data });
          await tx.client.query(
            `UPDATE ${relation(tx, 'variants')} SET state='published',platform_post_id=$2,permalink=$3 WHERE id=$1`,
            [context.id, id.data, permalinkSchema.safeParse(result.permalink).data ?? null],
          );
          return;
        }
        await settleReceipt(tx, claimed.receiptId, 'failed', {
          error: { class: 'rejected', code: safeCode(result.code) },
        });
        await tx.client.query(`UPDATE ${relation(tx, 'variants')} SET state='failed' WHERE id=$1`, [context.id]);
        return;
      }
      const error = outcome.error;
      const phase = phaseOf(error);
      if (error instanceof MediaUrlUnavailable) {
        await settleReceipt(tx, claimed.receiptId, 'failed', {
          error: { class: 'retry', code: 'media-url-unavailable' },
        });
        await toProcessing(tx, context.id);
        await block(tx, context, 'media-unreadable');
        return;
      }
      const kind = adapter.classify(asError(error), phase);
      const code = safeCode(typeof error === 'object' && error !== null && 'code' in error ? error.code : null);
      if (kind === 'rejected') {
        await settleReceipt(tx, claimed.receiptId, 'failed', { error: { class: kind, code } });
        await tx.client.query(`UPDATE ${relation(tx, 'variants')} SET state='failed' WHERE id=$1`, [context.id]);
        return;
      }
      if (kind === 'rate-limited' || kind === 'reconnect') {
        // The platform refused the request, so it did not take effect.
        await settleReceipt(tx, claimed.receiptId, 'failed', { error: { class: kind, code } });
        await toProcessing(tx, context.id);
        await block(tx, context, kind === 'rate-limited' ? 'rate-limited' : 'account-reconnect');
        reconnect = kind === 'reconnect';
        return;
      }
      if (phase === 'before-send') {
        await settleReceipt(tx, claimed.receiptId, 'failed', { error: { class: kind, code } });
        const failures = context.receipts.filter(
          receipt =>
            receipt.step === claimed.step.kind && receipt.status === 'failed' && receipt.error_class !== 'rate-limited',
        ).length;
        if (failures + 1 >= beforeSendAttemptLimit) {
          await tx.client.query(`UPDATE ${relation(tx, 'variants')} SET state='failed' WHERE id=$1`, [context.id]);
          return;
        }
        await tx.client.query(
          `UPDATE ${relation(tx, 'variants')} SET state='processing',next_attempt_at=clock_timestamp()+interval '60 seconds'
            WHERE id=$1`,
          [context.id],
        );
        return;
      }
      // Sent, and the platform did not say what happened: never retried automatically (PRODUCT 24).
      await settleReceipt(tx, claimed.receiptId, 'outcome-unknown', { error: { class: 'unknown', code } });
      await unknown(tx, context.id);
    });
    if (reconnect)
      await options.accounts.tokenRejected(workspaceId, claimed.channel.account.id, claimed.channel.account.generation);
  }
  async function toProcessing(tx: AuthorizationTransaction, id: string) {
    await tx.client.query(`UPDATE ${relation(tx, 'variants')} SET state='processing' WHERE id=$1`, [id]);
  }
  const sameStep = (context: Context, expected: Context) =>
    context.state === expected.state &&
    context.attempt_id === expected.attempt_id &&
    JSON.stringify(context.step) === JSON.stringify(expected.step);
  const due = (context: Context) =>
    context.state === 'scheduled'
      ? context.due_at !== null && context.due_at.getTime() <= context.db_now.getTime()
      : context.state === 'processing' &&
        context.next_attempt_at !== null &&
        context.next_attempt_at.getTime() <= context.db_now.getTime();

  /** An await step only reads the platform, so it is polled with backoff until it ends (PRODUCT 23). */
  async function poll(workspaceId: string, variantId: string, expected: Context, adapter: SocialPlatformAdapter) {
    const leased = await transaction(workspaceId, async tx => {
      const context = await load(tx, variantId, 'skip');
      if (!context || !sameStep(context, expected) || !due(context)) return null;
      const target = planned(context, adapter);
      if (!target || target.step.kind !== 'await') {
        await unknown(tx, context.id);
        return null;
      }
      const last = context.receipts.at(-1);
      const started = (last?.settled_at ?? last?.started_at ?? context.db_now).getTime();
      const elapsed = (context.db_now.getTime() - started) / 1000;
      if (elapsed > target.step.maxSeconds) {
        // Processing took longer than the platform's maximum.
        await unknown(tx, context.id);
        return null;
      }
      await tx.client.query(
        `UPDATE ${relation(tx, 'variants')} SET next_attempt_at=clock_timestamp()+make_interval(secs=>$2) WHERE id=$1`,
        [context.id, sendingLeaseSeconds],
      );
      const channel = await tx.client.query(
        `SELECT account_id,account_generation FROM ${relation(tx, 'channels')} WHERE id=$1`,
        [context.channel_id],
      );
      const row = z.object({ account_id: z.uuid(), account_generation: z.number().int() }).parse(channel.rows[0]);
      return { context, target, elapsed, last, account: row };
    });
    if (!leased) return;
    const { context, target, last } = leased;
    const step = target.step as AwaitStep;
    const backoff = async (seconds: number) =>
      transaction(workspaceId, tx =>
        tx.client.query(
          `UPDATE ${relation(tx, 'variants')} SET next_attempt_at=clock_timestamp()+make_interval(secs=>$2)
            WHERE id=$1 AND state='processing' AND step=$3::jsonb`,
          [context.id, seconds, JSON.stringify(context.step)],
        ),
      );
    let token: TokenSet;
    try {
      const access = await options.accounts.accessToken(workspaceId, leased.account.account_id);
      if (access.account.generation !== leased.account.account_generation) throw new SocialError('account-conflict');
      token = access.token;
    } catch (error) {
      const blocked =
        error instanceof SocialError || error instanceof AccessDenied ? blockedFor(error) : { skip: true };
      if (isBlocked(blocked))
        await transaction(workspaceId, async tx => {
          const current = await load(tx, variantId, 'wait');
          if (current?.state === 'processing' && JSON.stringify(current.step) === JSON.stringify(context.step))
            await block(tx, current, blocked.blocked);
        });
      else await backoff(awaitBackoffSeconds.minimum * 6);
      return;
    }
    const channel = await transaction(workspaceId, tx =>
      channelOf(tx, context.channel_id, leased.account.account_generation),
    );
    const input = stepInput(context, adapter, channel, token, last?.attempt_id ?? randomUUID(), 'await');
    let status;
    try {
      status = await observe(() => adapter.status(step, input));
    } catch (error) {
      const kind = adapter.classify(asError(error), 'before-send');
      if (kind === 'reconnect') {
        await options.accounts.tokenRejected(workspaceId, leased.account.account_id, leased.account.account_generation);
        await transaction(workspaceId, async tx => {
          const current = await load(tx, variantId, 'wait');
          if (current?.state === 'processing' && JSON.stringify(current.step) === JSON.stringify(context.step))
            await block(tx, current, 'account-reconnect');
        });
        return;
      }
      await backoff(clamp(leased.elapsed / 4, awaitBackoffSeconds));
      return;
    }
    await transaction(workspaceId, async tx => {
      const current = await load(tx, variantId, 'wait');
      if (current?.state !== 'processing' || JSON.stringify(current.step) !== JSON.stringify(context.step)) return;
      if (status.kind === 'pending') {
        const seconds = clamp(Math.max(status.pollAfterSeconds, leased.elapsed / 4), awaitBackoffSeconds);
        await tx.client.query(
          `UPDATE ${relation(tx, 'variants')} SET next_attempt_at=clock_timestamp()+make_interval(secs=>$2) WHERE id=$1`,
          [current.id, seconds],
        );
      } else if (status.kind === 'ready') {
        const next = nextStep(target.plan, target.index);
        if (next)
          await tx.client.query(
            `UPDATE ${relation(tx, 'variants')} SET step=$2,next_attempt_at=clock_timestamp() WHERE id=$1`,
            [current.id, JSON.stringify(next)],
          );
        else await unknown(tx, current.id);
      } else if (status.kind === 'published') {
        const id = platformPostIdSchema.safeParse(status.platformPostId);
        if (!id.success) await unknown(tx, current.id);
        else
          await tx.client.query(
            `UPDATE ${relation(tx, 'variants')} SET state='published',platform_post_id=$2,permalink=$3 WHERE id=$1`,
            [current.id, id.data, permalinkSchema.safeParse(status.permalink).data ?? null],
          );
      } else await tx.client.query(`UPDATE ${relation(tx, 'variants')} SET state='failed' WHERE id=$1`, [current.id]);
    });
  }

  async function channelOf(tx: AuthorizationTransaction, channelId: string, generation: number): Promise<Channel> {
    const row = z
      .object({
        id: z.uuid(),
        account_id: z.uuid(),
        platform: platformSchema,
        channel_kind: channelKindSchema,
        platform_channel_id: z.string(),
        display_name: z.string(),
        version: z.number().int().positive(),
        enabled: z.boolean(),
        engagement_policy: engagementPolicySchema,
      })
      .parse(
        (
          await tx.client.query(
            `SELECT id,account_id,platform,channel_kind,platform_channel_id,display_name,version,enabled,engagement_policy
               FROM ${relation(tx, 'channels')} WHERE id=$1`,
            [channelId],
          )
        ).rows[0],
      );
    const none = { memberIds: [], teamIds: [] };
    return {
      id: row.id,
      accountId: row.account_id,
      platform: row.platform,
      channelKind: row.channel_kind,
      platformChannelId: row.platform_channel_id,
      displayName: row.display_name,
      accountGeneration: generation,
      version: row.version,
      enabled: row.enabled,
      engagementPolicy: row.engagement_policy,
      grants: { publish: none, analytics: none, engagement: none, manage: none },
    };
  }

  /** Reads the platform for a variant whose outcome is unknown, by the latest attempt's references (PRODUCT 24). */
  async function reconcileRead(workspaceId: string, context: Context, adapter: SocialPlatformAdapter) {
    const last = context.receipts.at(-1);
    if (!last) return { kind: 'unknown' } satisfies ReconcileResult;
    const account = await transaction(workspaceId, async tx =>
      z
        .object({ account_id: z.uuid(), account_generation: z.number().int() })
        .parse(
          (
            await tx.client.query(`SELECT account_id,account_generation FROM ${relation(tx, 'channels')} WHERE id=$1`, [
              context.channel_id,
            ])
          ).rows[0],
        ),
    );
    const access = await options.accounts.accessToken(workspaceId, account.account_id);
    if (access.account.generation !== account.account_generation) throw new SocialError('account-reconnect-required');
    const channel = await transaction(workspaceId, tx => channelOf(tx, context.channel_id, account.account_generation));
    const input: ReconcileInput = {
      variant: toVariant(context),
      channel,
      token: access.token,
      attemptId: last.attempt_id,
      idempotencyKey: idempotencyKey(context.id, last.step),
      step: last.step,
      platformRefs: { ...context.platform_refs, ...last.platform_refs },
      startedAt: last.started_at,
    };
    return observe(() => adapter.reconcile(input));
  }

  /** Settles `outcome-unknown` only on authoritative evidence; candidates wait for a person (PRODUCT 24). */
  async function reconcile(workspaceId: string, variantId: string, adapter: SocialPlatformAdapter) {
    const leased = await transaction(workspaceId, async tx => {
      const context = await load(tx, variantId, 'skip');
      if (
        context?.state !== 'outcome-unknown' ||
        (context.next_attempt_at && context.next_attempt_at.getTime() > context.db_now.getTime())
      )
        return null;
      const started = context.receipts.at(-1)?.started_at.getTime() ?? context.db_now.getTime();
      const seconds = clamp((context.db_now.getTime() - started) / 2000, reconcileBackoffSeconds);
      await tx.client.query(
        `UPDATE ${relation(tx, 'variants')} SET next_attempt_at=clock_timestamp()+make_interval(secs=>$2) WHERE id=$1`,
        [context.id, seconds],
      );
      return context;
    });
    if (!leased) return;
    let result: ReconcileResult;
    try {
      result = await reconcileRead(workspaceId, leased, adapter);
    } catch {
      return;
    }
    if (result.kind !== 'found' && result.kind !== 'absent') return;
    await transaction(workspaceId, async tx => {
      const context = await load(tx, variantId, 'wait');
      if (context?.state !== 'outcome-unknown' || context.attempt_id !== leased.attempt_id) return;
      if (result.kind === 'absent') {
        await tx.client.query(`UPDATE ${relation(tx, 'variants')} SET state='not-published' WHERE id=$1`, [context.id]);
        return;
      }
      const id = platformPostIdSchema.safeParse(result.platformPostId);
      if (id.success)
        await tx.client.query(
          `UPDATE ${relation(tx, 'variants')} SET state='published',platform_post_id=$2 WHERE id=$1`,
          [context.id, id.data],
        );
    });
  }

  /** Runs the variant's due steps in order; each step has its own transactions. */
  async function advance(workspaceId: string, variantId: string) {
    for (let index = 0; index < stepsPerVariant; index++) {
      const context = await transaction(workspaceId, tx => load(tx, variantId, 'none'));
      if (!context || !due(context)) return;
      const adapter = adapterFor(context.platform);
      if (!adapter) return;
      const target = planned(context, adapter);
      if (target?.step.kind === 'await') await poll(workspaceId, variantId, context, adapter);
      else await mutate(workspaceId, variantId, context, adapter);
      const after = await transaction(workspaceId, tx => load(tx, variantId, 'none'));
      if (!after || sameStep(after, context)) return;
    }
  }

  /** Applies `update` to each selected variant in its own transaction; variants of one post never share one. */
  async function eachVariant(
    workspaceId: string,
    select: (tx: AuthorizationTransaction) => string,
    update: (tx: AuthorizationTransaction, context: Context) => Promise<void>,
  ) {
    const ids = await transaction(workspaceId, async tx =>
      z
        .array(z.object({ id: z.uuid() }))
        .parse((await tx.client.query(`${select(tx)} LIMIT ${sweepBatch}`)).rows)
        .map(row => row.id),
    );
    for (const id of ids)
      await transaction(workspaceId, async tx => {
        const context = await load(tx, id, 'skip');
        if (context) await update(tx, context);
      });
    return ids;
  }

  /**
   * Caller checks for a command: the caller holds `publish` on the variant's channel. A channel or connection
   * that cannot be used now still lets its publishers cancel or settle (grants are checked before state).
   */
  async function requirePublisher(tx: AuthorizationTransaction, userId: string, channelId: string) {
    try {
      const authorized = await options.channels.authorizeWithin(tx, userId, channelId, 'publish');
      return authorized.sponsorMembershipId;
    } catch (error) {
      if (!(error instanceof SocialError)) throw error;
      const row = z
        .object({ id: z.uuid() })
        .parse(
          (
            await tx.client.query(
              `SELECT id FROM ${qualified(tx.schema, 'tf_memberships')} WHERE user_id=$1 AND removed_at IS NULL`,
              [userId],
            )
          ).rows[0],
        );
      return row.id;
    }
  }
  async function command(workspaceId: string, userId: string, variantId: string, expectedState: string) {
    return transaction(workspaceId, async tx => {
      const context = await load(tx, variantId, 'wait');
      if (!context) throw new AccessDenied();
      const membershipId = await requirePublisher(tx, userId, context.channel_id);
      if (context.state !== expectedState) throw new SocialError('variant-conflict');
      return { context, actor: { kind: 'human', userId, membershipId } as HumanActor };
    });
  }
  async function view(workspaceId: string, variantId: string) {
    return transaction(workspaceId, async tx => toVariant((await load(tx, variantId, 'none'))!));
  }

  return {
    /**
     * One pass over a workspace: expire undecided revisions, cancel variants blocked for 7 days, recheck temporary
     * blocks, expire `sending` leases, run due steps and reconcile unknown outcomes (TECH, The step sweep).
     */
    async sweep(workspaceId: string) {
      const failures: unknown[] = [];
      const guarded = async (call: () => Promise<unknown>) => {
        try {
          await call();
        } catch (error) {
          failures.push(error);
        }
      };
      await guarded(() =>
        eachVariant(
          workspaceId,
          tx =>
            `SELECT v.id FROM ${relation(tx, 'variants')} v JOIN ${relation(tx, 'revisions')} r ON r.post_id=v.post_id AND r.number=v.revision
              WHERE v.state IN ('draft','awaiting-approval') AND r.expires_at<=clock_timestamp()
                AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'decisions')} d WHERE d.post_id=v.post_id AND d.revision=v.revision)
              ORDER BY r.expires_at`,
          async (tx, context) => {
            await tx.client.query(
              `UPDATE ${relation(tx, 'variants')} v SET state='cancelled' WHERE id=$1 AND state IN ('draft','awaiting-approval')
                 AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'decisions')} d WHERE d.post_id=v.post_id AND d.revision=v.revision)
                 AND EXISTS (SELECT 1 FROM ${relation(tx, 'revisions')} r WHERE r.post_id=v.post_id AND r.number=v.revision AND r.expires_at<=clock_timestamp())`,
              [context.id],
            );
          },
        ),
      );
      await guarded(() =>
        eachVariant(
          workspaceId,
          tx =>
            `SELECT id FROM ${relation(tx, 'variants')} WHERE state='blocked'
              AND due_at+make_interval(secs=>${blockedLifetimeMs / 1000})<=clock_timestamp() ORDER BY due_at`,
          async (tx, context) => {
            if (context.state !== 'blocked' || context.due_at!.getTime() + blockedLifetimeMs > context.db_now.getTime())
              return;
            await tx.client.query(
              `UPDATE ${relation(tx, 'variants')} SET state='cancelled',blocked_reason=NULL,recheck_at=NULL WHERE id=$1`,
              [context.id],
            );
          },
        ),
      );
      await guarded(() =>
        eachVariant(
          workspaceId,
          tx =>
            `SELECT id FROM ${relation(tx, 'variants')} WHERE state='blocked' AND recheck_at<=clock_timestamp() ORDER BY recheck_at`,
          async (tx, context) => {
            if (context.state !== 'blocked' || !context.recheck_at || context.recheck_at > context.db_now) return;
            await tx.client.query(
              `UPDATE ${relation(tx, 'variants')} SET state=$2::text,blocked_reason=NULL,recheck_at=NULL,
                      next_attempt_at=CASE WHEN $2::text='processing' THEN clock_timestamp() ELSE next_attempt_at END
                WHERE id=$1`,
              [context.id, context.receipts.length ? 'processing' : 'scheduled'],
            );
          },
        ),
      );
      await guarded(() =>
        eachVariant(
          workspaceId,
          tx =>
            `SELECT id FROM ${relation(tx, 'variants')} WHERE state='sending' AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at`,
          async (tx, context) => {
            if (context.state !== 'sending' || context.next_attempt_at! > context.db_now) return;
            const receipt = context.receipts.find(
              item => item.attempt_id === context.attempt_id && item.status === 'executing',
            );
            if (receipt)
              await settleReceipt(tx, receipt.id, 'outcome-unknown', {
                error: { class: 'unknown', code: 'lease-expired' },
              });
            await unknown(tx, context.id);
          },
        ),
      );
      const due = await transaction(workspaceId, async tx =>
        z
          .array(z.object({ id: z.uuid() }))
          .parse(
            (
              await tx.client.query(
                `SELECT id FROM ${relation(tx, 'variants')}
                  WHERE (state='scheduled' AND due_at<=clock_timestamp()) OR (state='processing' AND next_attempt_at<=clock_timestamp())
                  ORDER BY COALESCE(next_attempt_at,due_at) LIMIT ${sweepBatch}`,
              )
            ).rows,
          )
          .map(row => row.id),
      );
      for (const id of due) await guarded(() => advance(workspaceId, id));
      const unsettled = await transaction(workspaceId, async tx =>
        z.array(z.object({ id: z.uuid(), platform: platformSchema })).parse(
          (
            await tx.client.query(
              `SELECT v.id,c.platform FROM ${relation(tx, 'variants')} v JOIN ${relation(tx, 'channels')} c ON c.id=v.channel_id
                  WHERE v.state='outcome-unknown' AND (v.next_attempt_at IS NULL OR v.next_attempt_at<=clock_timestamp())
                  ORDER BY v.next_attempt_at NULLS FIRST LIMIT ${sweepBatch}`,
            )
          ).rows,
        ),
      );
      for (const row of unsettled) {
        const adapter = adapterFor(row.platform);
        if (adapter) await guarded(() => reconcile(workspaceId, row.id, adapter));
      }
      if (failures.length) throw new AggregateError(failures, 'Social publisher sweep incomplete');
    },

    /**
     * Reruns every check for a blocked variant, for its sponsor. If they pass it is due again; otherwise it stays
     * blocked with the current reason (PRODUCT 25). The caller needs `publish` on the channel.
     */
    async resume(workspaceId: string, userId: string, raw: unknown): Promise<Variant> {
      const input = variantCommandSchema.parse(raw);
      if (input.expectedState !== 'blocked') throw new SocialError('variant-conflict');
      const { context, actor } = await command(workspaceId, userId, input.variantId, input.expectedState);
      const adapter = adapterFor(context.platform);
      if (!adapter) throw new SocialError('platform-unavailable');
      const first = await transaction(workspaceId, async tx => {
        const current = await load(tx, context.id, 'wait');
        if (current?.state !== 'blocked') throw new SocialError('variant-conflict');
        return { current, result: await databaseChecks(tx, current) };
      });
      if (isSkip(first.result)) throw new SocialError('account-unavailable');
      const ready = isBlocked(first.result)
        ? first.result
        : await platformChecks(workspaceId, first.current, adapter, first.result);
      if (isSkip(ready)) throw new SocialError('account-unavailable');
      await transaction(workspaceId, async tx => {
        const current = await load(tx, context.id, 'wait');
        if (current?.state !== 'blocked') throw new SocialError('variant-conflict');
        const checked = isBlocked(ready) ? ready : await databaseChecks(tx, current);
        if (isSkip(checked)) throw new SocialError('account-unavailable');
        if (isBlocked(checked)) await block(tx, current, checked.blocked);
        else
          await tx.client.query(
            `UPDATE ${relation(tx, 'variants')} SET state=$2::text,blocked_reason=NULL,recheck_at=NULL,
                    next_attempt_at=CASE WHEN $2::text='processing' THEN clock_timestamp() ELSE next_attempt_at END
              WHERE id=$1`,
            [current.id, current.receipts.length ? 'processing' : 'scheduled'],
          );
        await audit(tx, actor, current.post_id, 'resume');
      });
      return view(workspaceId, context.id);
    },

    /** Cancels a blocked variant (PRODUCT 25). The caller needs `publish` on the channel. */
    async cancel(workspaceId: string, userId: string, raw: unknown): Promise<Variant> {
      const input = variantCommandSchema.parse(raw);
      if (input.expectedState !== 'blocked') throw new SocialError('variant-conflict');
      await transaction(workspaceId, async tx => {
        const context = await load(tx, input.variantId, 'wait');
        if (!context) throw new AccessDenied();
        const membershipId = await requirePublisher(tx, userId, context.channel_id);
        if (context.state !== input.expectedState) throw new SocialError('variant-conflict');
        await tx.client.query(
          `UPDATE ${relation(tx, 'variants')} SET state='cancelled',blocked_reason=NULL,recheck_at=NULL WHERE id=$1`,
          [context.id],
        );
        await audit(tx, { kind: 'human', userId, membershipId }, context.post_id, 'cancel');
      });
      return view(workspaceId, input.variantId);
    },

    /** The platform's current answer for a variant whose outcome is unknown, for a person to review (PRODUCT 24). */
    async candidates(workspaceId: string, userId: string, variantId: string): Promise<ReconcileResult> {
      const { context } = await command(workspaceId, userId, variantId, 'outcome-unknown');
      const adapter = adapterFor(context.platform);
      if (!adapter) throw new SocialError('platform-unavailable');
      return reconcileRead(workspaceId, context, adapter);
    },

    /**
     * A person settles an unknown outcome: `published` confirms a candidate or found post by its `platformPostId`;
     * `not-published` rejects every candidate (PRODUCT 24). The caller needs `publish` on the channel.
     */
    async settle(workspaceId: string, userId: string, raw: unknown): Promise<Variant> {
      const input = settleCommandSchema.parse(raw);
      const { context, actor } = await command(workspaceId, userId, input.variantId, 'outcome-unknown');
      let permalink: string | null = null;
      if (input.settlement === 'published') {
        const adapter = adapterFor(context.platform);
        if (!adapter) throw new SocialError('platform-unavailable');
        const result = await reconcileRead(workspaceId, context, adapter);
        const candidate =
          result.kind === 'candidates'
            ? result.items.find(item => item.platformPostId === input.platformPostId)
            : result.kind === 'found' && result.platformPostId === input.platformPostId
              ? { platformPostId: result.platformPostId, permalink: null }
              : undefined;
        if (!candidate) throw new SocialError('settlement-unconfirmed');
        permalink = permalinkSchema.safeParse(candidate.permalink).data ?? null;
      }
      await transaction(workspaceId, async tx => {
        const current = await load(tx, context.id, 'wait');
        if (current?.state !== 'outcome-unknown' || current.attempt_id !== context.attempt_id)
          throw new SocialError('variant-conflict');
        if (input.settlement === 'published')
          await tx.client.query(
            `UPDATE ${relation(tx, 'variants')} SET state='published',platform_post_id=$2,permalink=$3 WHERE id=$1`,
            [current.id, input.platformPostId, permalink],
          );
        else
          await tx.client.query(`UPDATE ${relation(tx, 'variants')} SET state='not-published' WHERE id=$1`, [
            current.id,
          ]);
        await audit(tx, actor, current.post_id, `settle.${input.settlement}`);
      });
      return view(workspaceId, context.id);
    },
  };
}
export type SocialPublisher = ReturnType<typeof createSocialPublisher>;
