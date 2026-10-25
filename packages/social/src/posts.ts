import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  requireNoMcpDerived,
  sourceDependencySchema,
  type AuthorizationTransaction,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import type { SocialPlatformAdapter } from './adapter.ts';
import { socialCompatibility, type SocialAccounts, type SocialRuntime } from './accounts.ts';
import { batchDigest, contentDigest, contentDigestInput, type ContentDigestVariant } from './batch-digest.ts';
import type { AuthorizedChannel, ChannelPrincipal, SocialChannels } from './channels.ts';
import {
  contentIssues,
  decisionSubmitSchema,
  originSchema,
  platformContentSchema,
  postSchema,
  prepareInputSchema,
  reviewChoiceEntrySchema,
  reviewChoiceFieldSchema,
  reviseInputSchema,
  revisionExpiresAt,
  targetSchema,
  tiktokReviewChoiceIssues,
  variantStateSchema,
  type AccessTier,
  type DecisionReviewChoice,
  type Origin,
  type Platform,
  type PlatformContent,
  type Post,
  type PreparedPost,
  type ReviewChoiceField,
  type Target,
  type ValidationError,
  type VariantInput,
  type VariantState,
} from './contracts.ts';
import { SocialError } from './credentials.ts';
import { bindMedia, requireBoundMedia } from './media.ts';

/** Checks that `actor` may read every source, as a chat answer's reader must (PRODUCT 20). */
export type SourceCheck = (
  tx: AuthorizationTransaction,
  actor: HumanActor,
  sources: readonly SourceDependency[],
) => Promise<void>;
/** The sources a trusted caller resolved from the post's origin (TECH, Source closure). */
export type PostSources = { dependencies: readonly SourceDependency[] };

const uuid = z.uuid();
const dependenciesSchema = z.array(sourceDependencySchema).max(256);
const sourcesInputSchema = z.object({ dependencies: dependenciesSchema });
const supersedable: ReadonlySet<VariantState> = new Set(['draft', 'awaiting-approval', 'scheduled', 'blocked']);
const finalStates = ['published', 'failed', 'not-published', 'superseded', 'cancelled'];

const postRowSchema = z.object({
  id: z.uuid(),
  origin: originSchema,
  author_membership_id: z.uuid(),
  current_revision: z.number().int().positive(),
});
type PostRow = z.infer<typeof postRowSchema>;
const storedSourcesSchema = z.object({
  dependencies: dependenciesSchema,
  mcpDerived: z.boolean(),
  privateTaskDerived: z.boolean(),
});
const revisionRowSchema = z.object({
  number: z.number().int().positive(),
  content_digest: z.string(),
  sources: storedSourcesSchema,
  mcp_derived: z.boolean(),
  private_task_derived: z.boolean(),
  review_choices: z.array(reviewChoiceEntrySchema),
  expires_at: z.date(),
});
const decisionRowSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  batch_digest: z.string(),
  decision: z.enum(['approve', 'reject']),
  review_choices: z.array(z.object({ variantId: z.uuid(), values: z.unknown() })).nullable(),
  decider_membership_id: z.uuid(),
  decided_at: z.date(),
});
const variantRowSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  channel_id: z.uuid(),
  channel_version: z.number().int().positive(),
  target: targetSchema.nullable(),
  content: platformContentSchema,
  publish_at: z.date().nullable(),
  due_at: z.date().nullable(),
  state: variantStateSchema,
  step: z.unknown(),
  blocked_reason: z.string().nullable(),
  recheck_at: z.date().nullable(),
  platform_refs: z.record(z.string(), z.string()),
  platform_post_id: z.string().nullable(),
  permalink: z.string().nullable(),
  attempted: z.boolean(),
});
const receiptRowSchema = z.object({
  id: z.uuid(),
  variant_id: z.uuid(),
  revision: z.number().int().positive(),
  decision_id: z.uuid(),
  step: z.string(),
  attempt_id: z.uuid(),
  status: z.string(),
  started_at: z.date(),
  settled_at: z.date().nullable(),
  platform_refs: z.record(z.string(), z.string()),
  platform_post_id: z.string().nullable(),
  platform_request_id: z.string().nullable(),
  error_class: z.string().nullable(),
  error_code: z.string().nullable(),
});

const iso = (value: Date | null) => (value === null ? null : value.toISOString());
const uniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';

/** One variant's checks that need the platform: the channel grant, its target, and the adapter's rules. */
type Checked = {
  input: VariantInput;
  authorized: AuthorizedChannel;
  tier: AccessTier;
  errors: ValidationError[];
  required: ReviewChoiceField[] | null;
};

export function createSocialPosts(options: {
  runtime: SocialRuntime;
  accounts: Pick<SocialAccounts, 'accessToken'>;
  channels: Pick<SocialChannels, 'authorize' | 'authorizeWithin' | 'principal' | 'checkTarget'>;
  adapters: Partial<Record<Platform, SocialPlatformAdapter>>;
  /** The chat source check, `requireDraftSources` in the composition. */
  requireSources: SourceCheck;
  resolveConfirmationCredential: (workspaceId: string) => Promise<string>;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const relation = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_social_${name}`);
  const adapterFor = (platform: Platform) => {
    const adapter = options.adapters[platform];
    if (!adapter || adapter.platform !== platform) throw new SocialError('platform-unavailable');
    return adapter;
  };
  async function transaction<T>(
    workspaceId: string,
    operation: (tx: AuthorizationTransaction) => Promise<T>,
  ): Promise<T> {
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

  /**
   * A variant is checked against its channel before it can be submitted: the sponsor's `publish` grant at the
   * version read, the target's live rules (PRODUCT 12) and the adapter's content rules (PRODUCT 13).
   */
  async function checkVariant(workspaceId: string, principal: ChannelPrincipal, input: VariantInput) {
    const expected = { channelVersion: input.expectedChannelVersion };
    const authorized = await options.channels.authorize(workspaceId, principal, input.channelId, 'publish', expected);
    const adapter = adapterFor(authorized.channel.platform);
    const errors = await options.channels.checkTarget(
      workspaceId,
      principal,
      input.channelId,
      input.target ?? null,
      expected,
    );
    const access = await options.accounts.accessToken(workspaceId, authorized.account.id);
    if (access.account.generation !== authorized.channel.accountGeneration)
      throw new SocialError('account-reconnect-required');
    const tier = access.app.accessTier;
    errors.push(...adapter.validate(input, authorized.channel, tier));
    let required: ReviewChoiceField[] | null = null;
    if (authorized.channel.platform === 'tiktok') {
      // The fields only a person may set come from the creator's current settings (PRODUCT 17).
      required = adapter.reviewChoices
        ? z.array(reviewChoiceFieldSchema).parse(await adapter.reviewChoices(authorized.channel, access.token))
        : [...reviewChoiceFieldSchema.options];
    }
    return { input, authorized, tier, errors, required } satisfies Checked;
  }
  async function checkVariants(workspaceId: string, principal: ChannelPrincipal, inputs: readonly VariantInput[]) {
    const checked: Checked[] = [];
    for (const input of inputs) checked.push(await checkVariant(workspaceId, principal, input));
    return checked;
  }

  async function loadPost(tx: AuthorizationTransaction, postId: string, lock = false) {
    const row = postRowSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT id,origin,author_membership_id,current_revision FROM ${relation(tx, 'posts')} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
            [uuid.parse(postId)],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }
  async function loadRevision(tx: AuthorizationTransaction, postId: string, number: number) {
    return revisionRowSchema.parse(
      (
        await tx.client.query(
          `SELECT number,content_digest,sources,mcp_derived,private_task_derived,review_choices,expires_at
             FROM ${relation(tx, 'revisions')} WHERE post_id=$1 AND number=$2`,
          [postId, number],
        )
      ).rows[0],
    );
  }
  async function loadVariants(tx: AuthorizationTransaction, postId: string, revision?: number) {
    return z.array(variantRowSchema).parse(
      (
        await tx.client.query(
          `SELECT v.id,v.revision,v.channel_id,v.channel_version,v.target,v.content,v.publish_at,v.due_at,v.state,v.step,
                  v.blocked_reason,v.recheck_at,v.platform_refs,v.platform_post_id,v.permalink,
                  EXISTS (SELECT 1 FROM ${relation(tx, 'receipts')} r WHERE r.variant_id=v.id) AS attempted
             FROM ${relation(tx, 'variants')} v
            WHERE v.post_id=$1 AND ($2::integer IS NULL OR v.revision=$2) ORDER BY v.revision,v.channel_id`,
          [postId, revision ?? null],
        )
      ).rows,
    );
  }
  async function loadDecision(
    tx: { client: AuthorizationTransaction['client']; schema: string },
    postId: string,
    revision: number,
  ) {
    return decisionRowSchema.optional().parse(
      (
        await tx.client.query(
          `SELECT id,revision,batch_digest,decision,review_choices,decider_membership_id,decided_at
             FROM ${qualified(tx.schema, 'tf_social_decisions')} WHERE post_id=$1 AND revision=$2`,
          [postId, revision],
        )
      ).rows[0],
    );
  }

  /** The post as stored: every revision, its decision, and each variant's own state and receipts (PRODUCT 18). */
  async function view(tx: AuthorizationTransaction, post: PostRow): Promise<Post> {
    const revisions = z.array(revisionRowSchema).parse(
      (
        await tx.client.query(
          `SELECT number,content_digest,sources,mcp_derived,private_task_derived,review_choices,expires_at
             FROM ${relation(tx, 'revisions')} WHERE post_id=$1 ORDER BY number`,
          [post.id],
        )
      ).rows,
    );
    const decisions = z.array(decisionRowSchema).parse(
      (
        await tx.client.query(
          `SELECT id,revision,batch_digest,decision,review_choices,decider_membership_id,decided_at
             FROM ${relation(tx, 'decisions')} WHERE post_id=$1`,
          [post.id],
        )
      ).rows,
    );
    const variants = await loadVariants(tx, post.id);
    const receipts = z.array(receiptRowSchema).parse(
      (
        await tx.client.query(
          `SELECT r.id,r.variant_id,r.revision,r.decision_id,r.step,r.attempt_id,r.status,r.started_at,r.settled_at,
                  r.platform_refs,r.platform_post_id,r.platform_request_id,r.error_class,r.error_code
             FROM ${relation(tx, 'receipts')} r JOIN ${relation(tx, 'variants')} v ON v.id=r.variant_id
            WHERE v.post_id=$1 ORDER BY r.started_at,r.id`,
          [post.id],
        )
      ).rows,
    );
    return postSchema.parse({
      id: post.id,
      origin: post.origin,
      authorMembershipId: post.author_membership_id,
      currentRevision: post.current_revision,
      revisions: revisions.map(revision => {
        const decision = decisions.find(row => row.revision === revision.number);
        return {
          postId: post.id,
          number: revision.number,
          contentDigest: revision.content_digest,
          sources: revision.sources,
          reviewChoices: revision.review_choices,
          expiresAt: revision.expires_at.toISOString(),
          decision: decision
            ? {
                id: decision.id,
                postId: post.id,
                revision: decision.revision,
                batchDigest: decision.batch_digest,
                decision: decision.decision,
                ...(decision.review_choices ? { reviewChoices: decision.review_choices } : {}),
                deciderMembershipId: decision.decider_membership_id,
                decidedAt: decision.decided_at.toISOString(),
              }
            : null,
          variants: variants
            .filter(variant => variant.revision === revision.number)
            .map(variant => ({
              id: variant.id,
              postId: post.id,
              revision: variant.revision,
              channelId: variant.channel_id,
              channelVersion: variant.channel_version,
              target: variant.target,
              content: variant.content,
              publishAt: iso(variant.publish_at),
              dueAt: iso(variant.due_at),
              state: variant.state,
              step: variant.step ?? null,
              blockedReason: variant.blocked_reason,
              recheckAt: iso(variant.recheck_at),
              platformRefs: variant.platform_refs,
              platformPostId: variant.platform_post_id,
              permalink: variant.permalink,
              receipts: receipts
                .filter(receipt => receipt.variant_id === variant.id)
                .map(receipt => ({
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
            })),
        };
      }),
    });
  }

  /**
   * The source flags a revision stores. MCP output and private task results may not leave the workspace, so
   * either flag blocks approval (PRODUCT 20). A revision without them must be readable by its author.
   */
  async function sourceFlags(tx: AuthorizationTransaction, author: HumanActor, dependencies: SourceDependency[]) {
    const privateTaskDerived = dependencies.some(source => source.kind === 'private-task');
    let mcpDerived = false;
    try {
      await requireNoMcpDerived(
        tx,
        dependencies.filter(source => source.kind !== 'private-task'),
      );
    } catch (error) {
      if (!(error instanceof AccessDenied)) throw error;
      mcpDerived = true;
    }
    if (!mcpDerived && !privateTaskDerived) {
      try {
        await options.requireSources(tx, author, dependencies);
      } catch (error) {
        if (error instanceof AccessDenied) throw new SocialError('source-unreadable');
        throw error;
      }
    }
    return { dependencies, mcpDerived, privateTaskDerived };
  }

  type Draft = {
    channelId: string;
    channelVersion: number;
    target: Target | null;
    content: PlatformContent;
    publishAt: string | null;
    errors: ValidationError[];
    required: ReviewChoiceField[] | null;
  };
  /** Binds media for the author and adds the rules that need the Files (PRODUCT 13, 19). */
  async function draft(tx: AuthorizationTransaction, author: HumanActor, checked: Checked): Promise<Draft> {
    const content = checked.input.content;
    const bound = await bindMedia(tx, author, content.media);
    const unusable = new Set(bound.issues.map(issue => issue.path[2]));
    const issues = contentIssues(content, {
      channelKind: checked.authorized.channel.channelKind,
      mediaKinds: bound.kinds,
      mediaFiles: bound.files,
      xPremium: false,
    })
      .filter(issue => !(issue.code === 'media-kind-unknown' && unusable.has(issue.path[1])))
      .map(issue => ({ path: ['content', ...issue.path], code: issue.code }));
    return {
      channelId: checked.input.channelId,
      channelVersion: checked.input.expectedChannelVersion,
      target: checked.input.target ?? null,
      content,
      publishAt: checked.input.publishAt,
      errors: [...checked.errors, ...bound.issues, ...issues],
      required: checked.required,
    };
  }

  /** Writes an immutable revision and its variants: `awaiting-approval` when every variant is valid (PRODUCT 13). */
  async function writeRevision(
    tx: AuthorizationTransaction,
    postId: string,
    number: number,
    drafts: Draft[],
    sources: Awaited<ReturnType<typeof sourceFlags>>,
  ) {
    const valid = drafts.every(item => item.errors.length === 0);
    const variants = drafts.map(item => ({ ...item, id: randomUUID() }));
    const digestInput: ContentDigestVariant[] = variants;
    const reviewChoices = variants
      .filter(item => item.required !== null)
      .map(item => ({ variantId: item.id, platform: 'tiktok' as const, required: item.required!, values: null }));
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'revisions')}
         (post_id,number,content_digest,payload,sources,mcp_derived,private_task_derived,review_choices,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        postId,
        number,
        contentDigest(digestInput),
        JSON.stringify({ variants: contentDigestInput(digestInput) }),
        JSON.stringify(sources),
        sources.mcpDerived,
        sources.privateTaskDerived,
        JSON.stringify(reviewChoices),
        revisionExpiresAt(
          now(),
          variants.map(item => item.publishAt),
        ),
      ],
    );
    for (const item of variants)
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'variants')} (id,post_id,revision,channel_id,channel_version,target,content,publish_at,state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          item.id,
          postId,
          number,
          item.channelId,
          item.channelVersion,
          item.target === null ? null : JSON.stringify(item.target),
          JSON.stringify(item.content),
          item.publishAt,
          valid ? 'awaiting-approval' : 'draft',
        ],
      );
    return drafts.map(item => ({ channelId: item.channelId, valid: item.errors.length === 0, errors: item.errors }));
  }

  async function principalIn(tx: AuthorizationTransaction, principal: ChannelPrincipal) {
    return options.channels.principal(tx, principal);
  }

  /** Applies a recorded decision to the revision's variants; replaying it changes nothing more. */
  async function applyDecision(
    tx: AuthorizationTransaction,
    postId: string,
    revision: number,
    decision: z.infer<typeof decisionRowSchema>,
  ) {
    if (decision.decision === 'approve')
      await tx.client.query(
        `UPDATE ${relation(tx, 'variants')} SET state='scheduled',due_at=COALESCE(publish_at,$3)
          WHERE post_id=$1 AND revision=$2 AND state='awaiting-approval'`,
        [postId, revision, decision.decided_at],
      );
    else
      await tx.client.query(
        `UPDATE ${relation(tx, 'variants')} SET state='cancelled'
          WHERE post_id=$1 AND revision=$2 AND state<>ALL($3::text[])`,
        [postId, revision, finalStates],
      );
  }

  return {
    /**
     * Prepares a post with one variant per channel (PRODUCT 13). The sources come from a trusted caller that
     * resolved them from the origin; they are stored on the revision (PRODUCT 20). Repeating a command returns
     * the same post; the same command with other content is refused.
     */
    async prepare(
      workspaceId: string,
      principal: ChannelPrincipal,
      raw: unknown,
      sources: PostSources,
    ): Promise<PreparedPost> {
      const input = prepareInputSchema(now()).parse(raw);
      const dependencies = sourcesInputSchema.parse(sources).dependencies;
      const checked = await checkVariants(workspaceId, principal, input.variants);
      return transaction(workspaceId, async tx => {
        const { sponsor } = await principalIn(tx, principal);
        for (const item of checked)
          await options.channels.authorizeWithin(tx, principal, item.input.channelId, 'publish', {
            channelVersion: item.input.expectedChannelVersion,
          });
        const drafts: Draft[] = [];
        for (const item of checked) drafts.push(await draft(tx, sponsor, item));
        const digest = contentDigest(drafts);
        const id = randomUUID();
        const inserted = await tx.client.query(
          `INSERT INTO ${relation(tx, 'posts')} (id,command_id,origin,author_membership_id) VALUES ($1,$2,$3,$4)
           ON CONFLICT (author_membership_id,command_id) DO NOTHING RETURNING id`,
          [id, input.commandId, JSON.stringify(input.origin), sponsor.membershipId],
        );
        if (inserted.rowCount !== 1) {
          const existing = z.object({ id: z.uuid(), content_digest: z.string() }).parse(
            (
              await tx.client.query(
                `SELECT p.id,r.content_digest FROM ${relation(tx, 'posts')} p
                     JOIN ${relation(tx, 'revisions')} r ON r.post_id=p.id AND r.number=1
                    WHERE p.author_membership_id=$1 AND p.command_id=$2`,
                [sponsor.membershipId, input.commandId],
              )
            ).rows[0],
          );
          if (existing.content_digest !== digest) throw new SocialError('post-conflict');
          return {
            post: await view(tx, await loadPost(tx, existing.id)),
            variants: drafts.map(item => ({
              channelId: item.channelId,
              valid: !item.errors.length,
              errors: item.errors,
            })),
          };
        }
        const variants = await writeRevision(tx, id, 1, drafts, await sourceFlags(tx, sponsor, dependencies));
        await audit(tx, sponsor, id, 'prepare');
        return { post: await view(tx, await loadPost(tx, id)), variants };
      });
    },

    /**
     * Edits a post by writing revision `n + 1`, which needs its own approval. It covers only variants without
     * an attempted step; those are superseded on revision `n`, and attempted variants stay there with their
     * outcome (PRODUCT 16). Variants left out of the input are copied unchanged.
     */
    async revise(
      workspaceId: string,
      principal: ChannelPrincipal,
      postId: string,
      raw: unknown,
      sources: PostSources = { dependencies: [] },
    ): Promise<PreparedPost> {
      const input = reviseInputSchema(now()).parse(raw);
      const added = sourcesInputSchema.parse(sources).dependencies;
      const current = await transaction(workspaceId, async tx => {
        const { sponsor } = await principalIn(tx, principal);
        const post = await loadPost(tx, postId);
        if (post.author_membership_id !== sponsor.membershipId) throw new AccessDenied();
        return { post, variants: await loadVariants(tx, post.id, post.current_revision) };
      });
      if (input.expectedRevision !== current.post.current_revision) throw new SocialError('revision-conflict');
      const editable = current.variants.filter(row => supersedable.has(row.state) && !row.attempted);
      const editableChannels = new Set(editable.map(row => row.channel_id));
      if (!editable.length || input.variants.some(variant => !editableChannels.has(variant.channelId)))
        throw new SocialError('variant-not-editable');
      const replaced = new Map(input.variants.map(variant => [variant.channelId, variant]));
      const next = editable.map(
        (row): VariantInput =>
          replaced.get(row.channel_id) ?? {
            channelId: row.channel_id,
            expectedChannelVersion: row.channel_version,
            ...(row.target ? { target: row.target } : {}),
            content: row.content,
            publishAt: iso(row.publish_at),
          },
      );
      const checked = await checkVariants(workspaceId, principal, next);
      return transaction(workspaceId, async tx => {
        const { sponsor } = await principalIn(tx, principal);
        const post = await loadPost(tx, postId, true);
        if (post.author_membership_id !== sponsor.membershipId) throw new AccessDenied();
        if (post.current_revision !== input.expectedRevision) throw new SocialError('revision-conflict');
        const rows = await loadVariants(tx, post.id, post.current_revision);
        const stillEditable = rows.filter(row => supersedable.has(row.state) && !row.attempted);
        if (
          stillEditable.length !== editable.length ||
          stillEditable.some(row => !editable.some(before => before.id === row.id && before.state === row.state))
        )
          throw new SocialError('revision-conflict');
        for (const item of checked)
          await options.channels.authorizeWithin(tx, principal, item.input.channelId, 'publish', {
            channelVersion: item.input.expectedChannelVersion,
          });
        const previous = await loadRevision(tx, post.id, post.current_revision);
        const seen = new Set<string>();
        const dependencies = [...previous.sources.dependencies, ...added].filter(source => {
          const key = JSON.stringify(source);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const drafts: Draft[] = [];
        for (const item of checked) drafts.push(await draft(tx, sponsor, item));
        const number = post.current_revision + 1;
        const variants = await writeRevision(tx, post.id, number, drafts, await sourceFlags(tx, sponsor, dependencies));
        await tx.client.query(`UPDATE ${relation(tx, 'variants')} SET state='superseded' WHERE id=ANY($1::uuid[])`, [
          editable.map(row => row.id),
        ]);
        await tx.client.query(`UPDATE ${relation(tx, 'posts')} SET current_revision=$2 WHERE id=$1`, [post.id, number]);
        await audit(tx, sponsor, post.id, 'revise');
        return { post: await view(tx, await loadPost(tx, post.id)), variants };
      });
    },

    /**
     * Reads a post. Its author may always; anyone else needs `publish` on every current channel and must be able
     * to read every source, as an approver must (PRODUCT 20).
     */
    async get(workspaceId: string, principal: ChannelPrincipal, postId: string): Promise<Post> {
      return transaction(workspaceId, async tx => {
        const { sponsor } = await principalIn(tx, principal);
        const post = await loadPost(tx, postId);
        if (post.author_membership_id !== sponsor.membershipId) {
          for (const variant of await loadVariants(tx, post.id, post.current_revision))
            await options.channels.authorizeWithin(tx, principal, variant.channel_id, 'publish');
          const revision = await loadRevision(tx, post.id, post.current_revision);
          if (revision.mcp_derived || revision.private_task_derived) throw new AccessDenied();
          await options.requireSources(tx, sponsor, revision.sources.dependencies);
        }
        return view(tx, post);
      });
    },

    /**
     * A person approves or rejects the exact current revision. Approval covers every variant together and the
     * review choices only a person may set (PRODUCT 14, 15, 17). The approver must be able to read every source
     * and every media File, and no source may be MCP output or a private task result (PRODUCT 19, 20). The
     * decision is written through the confirmation role; agents cannot decide.
     */
    async decide(workspaceId: string, principal: string | HumanActor, raw: unknown): Promise<Post> {
      if (typeof principal === 'object' && (principal as { kind?: unknown }).kind === 'agent') throw new AccessDenied();
      const input = decisionSubmitSchema.parse(raw);
      const submitted: DecisionReviewChoice[] = input.reviewChoices ?? [];
      const batch = batchDigest(input.contentDigest, input.decision === 'approve' ? submitted : null);

      // TikTok choices also depend on the app's access tier, which may need a token refresh outside a transaction.
      const tiktok = await transaction(workspaceId, async tx => {
        const { sponsor } = await principalIn(tx, principal);
        const post = await loadPost(tx, input.postId);
        const accounts: { variantId: string; accountId: string }[] = [];
        for (const row of await loadVariants(tx, post.id, post.current_revision)) {
          const authorized = await options.channels.authorizeWithin(tx, sponsor, row.channel_id, 'publish');
          if (authorized.channel.platform === 'tiktok')
            accounts.push({ variantId: row.id, accountId: authorized.account.id });
        }
        return accounts;
      });
      const tierByVariant = new Map<string, AccessTier>();
      if (input.decision === 'approve')
        for (const { variantId, accountId } of tiktok)
          tierByVariant.set(variantId, (await options.accounts.accessToken(workspaceId, accountId)).app.accessTier);

      const checked = await transaction(workspaceId, async tx => {
        const { sponsor: actor } = await principalIn(tx, principal);
        const post = await loadPost(tx, input.postId);
        const rows = await loadVariants(tx, post.id, post.current_revision);
        for (const row of rows)
          await options.channels.authorizeWithin(tx, actor, row.channel_id, 'publish', {
            channelVersion: row.channel_version,
          });
        const revision = await loadRevision(tx, post.id, post.current_revision);
        if (input.expectedRevision !== post.current_revision || input.contentDigest !== revision.content_digest)
          throw new SocialError('revision-conflict');
        const previous = await loadDecision(tx, post.id, revision.number);
        if (previous) {
          if (previous.decision !== input.decision || previous.batch_digest !== batch)
            throw new SocialError('post-conflict');
          return { actor, post, revision, previous };
        }
        if (revision.expires_at.getTime() <= now().getTime()) throw new SocialError('revision-expired');
        if (input.decision === 'approve') {
          if (rows.some(row => row.state !== 'awaiting-approval')) throw new SocialError('variant-invalid');
          if (revision.mcp_derived || revision.private_task_derived) throw new SocialError('source-blocked');
          try {
            await requireNoMcpDerived(tx, revision.sources.dependencies);
          } catch (error) {
            if (error instanceof AccessDenied) throw new SocialError('source-blocked');
            throw error;
          }
          try {
            await options.requireSources(tx, actor, revision.sources.dependencies);
          } catch (error) {
            if (error instanceof AccessDenied) throw new SocialError('source-unreadable');
            throw error;
          }
          for (const row of rows) await requireBoundMedia(tx, actor, row.content.media);
          const required = revision.review_choices.filter(entry => entry.required.length);
          const byVariant = new Map(submitted.map(choice => [choice.variantId, choice]));
          if (byVariant.size !== submitted.length || submitted.length !== required.length)
            throw new SocialError('review-choices-invalid');
          for (const entry of required) {
            const choice = byVariant.get(entry.variantId);
            const tier = tierByVariant.get(entry.variantId);
            if (!choice || !tier || tiktokReviewChoiceIssues(choice.values, tier).length)
              throw new SocialError('review-choices-invalid');
          }
        }
        return { actor, post, revision, previous: undefined };
      });

      const { actor, post, revision } = checked;
      if (!checked.previous) {
        try {
          await withMaintenanceTransaction({
            connectionString: await options.resolveConfirmationCredential(workspaceId),
            workspaceId,
            capability: 'confirmation',
            operation: async tx => {
              await lockAuthorization(tx);
              await currentMember(tx, actor);
              const current = z
                .object({ current_revision: z.number().int().positive() })
                .parse(
                  (
                    await tx.client.query(
                      `SELECT current_revision FROM ${qualified(tx.schema, 'tf_social_posts')} WHERE id=$1`,
                      [post.id],
                    )
                  ).rows[0],
                );
              if (current.current_revision !== revision.number) throw new SocialError('revision-conflict');
              // A concurrent decision is compared with this one below.
              if (await loadDecision(tx, post.id, revision.number)) return;
              await tx.client.query(
                `INSERT INTO ${qualified(tx.schema, 'tf_social_decisions')}
                   (id,post_id,revision,content_digest,batch_digest,decision,review_choices,decider_membership_id,sponsor_membership_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [
                  randomUUID(),
                  post.id,
                  revision.number,
                  revision.content_digest,
                  batch,
                  input.decision,
                  input.decision === 'approve' ? JSON.stringify(submitted) : null,
                  actor.membershipId,
                  sponsorFor(post.origin, actor),
                ],
              );
            },
          });
        } catch (error) {
          if (!uniqueViolation(error)) throw error;
        }
      }
      return transaction(workspaceId, async tx => {
        const current = await loadPost(tx, post.id, true);
        const decision = await loadDecision(tx, post.id, revision.number);
        if (!decision || decision.decision !== input.decision || decision.batch_digest !== batch)
          throw new SocialError('post-conflict');
        await applyDecision(tx, post.id, revision.number, decision);
        if (!checked.previous) await audit(tx, actor, post.id, input.decision);
        return view(tx, current);
      });
    },
  };
}
export type SocialPosts = ReturnType<typeof createSocialPosts>;

/** The member a variant publishes for: the approver of a chat or task post; a Workflow run names its own (PRODUCT 22). */
function sponsorFor(origin: Origin, approver: HumanActor) {
  return origin.kind === 'workflow-run' ? null : approver.membershipId;
}
