import { z } from 'zod';
import {
  hasMemberIdentities,
  identityProviders,
  observeExternalHandle,
  type IdentityTransaction,
} from '@tulipfarm/integrations/member-identities';
import { githubLoginSchema } from './contracts.ts';
import {
  githubBranchSelectionSchema,
  githubCommentActionSchema,
  githubEventFieldsSchema,
  githubEventIdSchema,
  githubEventSelectionSchema,
  githubPullRequestActionSchema,
  githubRepositorySelectionSchema,
  githubReviewActionSchema,
} from './event-contracts.ts';

export class GitHubEventError extends Error {
  readonly code: 'event-invalid' | 'event-context-mismatch' | 'event-input-too-large';
  constructor(code: GitHubEventError['code']) {
    super(code);
    this.code = code;
  }
}
export const githubEventInputByteLimit = 32768;
const providerId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String).pipe(githubEventIdSchema);
const eventName = z.enum(['pull_request', 'pull_request_review', 'pull_request_review_comment', 'issue_comment']);
const actions = {
  pull_request: githubPullRequestActionSchema.exclude(['merged']),
  pull_request_review: githubReviewActionSchema,
  pull_request_review_comment: githubCommentActionSchema,
  issue_comment: githubCommentActionSchema,
};
const text = z.string().max(4000),
  number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const repository = z.object({
  id: providerId,
  full_name: z
    .string()
    .max(255)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  html_url: z.string(),
  private: z.boolean(),
  owner: z.object({ id: providerId, type: z.enum(['User', 'Organization']) }),
});
const identity = z.object({ id: providerId.optional(), login: text });
const pullRequest = z
  .object({
    number,
    title: text,
    html_url: z.string(),
    user: identity,
    state: z.enum(['open', 'closed']),
    merged: z.boolean().optional(),
    merged_at: z.iso.datetime().nullable(),
    base: z.object({ ref: z.string(), repo: z.object({ id: providerId }) }),
    head: z.object({ ref: z.string() }),
  })
  .refine(
    pull =>
      (pull.state !== 'open' || pull.merged_at === null) &&
      (pull.merged === undefined || pull.merged === (pull.merged_at !== null)),
  );
const routing = z.strictObject({
  installationId: githubEventIdSchema,
  repositoryId: githubEventIdSchema,
  repositoryName: z.string(),
  ownerId: githubEventIdSchema,
  ownerKind: z.enum(['user', 'organization']),
  privateRepository: z.boolean(),
  number,
  event: eventName,
  action: z.union([githubPullRequestActionSchema, githubReviewActionSchema, githubCommentActionSchema]),
});
const completeFields = githubEventFieldsSchema.required({
  'repository.name': true,
  'repository.url': true,
  'pullRequest.number': true,
  'pullRequest.title': true,
  'pullRequest.url': true,
  'pullRequest.author': true,
  'pullRequest.state': true,
  'pullRequest.baseBranch': true,
  'pullRequest.headBranch': true,
  'event.action': true,
});
const pendingFields = githubEventFieldsSchema
  .pick({
    'repository.name': true,
    'repository.url': true,
    'pullRequest.number': true,
    'pullRequest.title': true,
    'pullRequest.url': true,
    'pullRequest.author': true,
    'event.action': true,
    'comment.body': true,
    'comment.url': true,
  })
  .required();
export const githubNormalizedEventSchema = routing
  .extend({ kind: z.literal('event'), fields: completeFields })
  .refine(
    event =>
      event.fields['event.action'] === event.action &&
      event.fields['pullRequest.number'] === event.number &&
      event.fields['repository.name'] === event.repositoryName &&
      event.fields['repository.url'] === `https://github.com/${event.repositoryName}` &&
      event.fields['pullRequest.url'] === `https://github.com/${event.repositoryName}/pull/${event.number}` &&
      ((event.event === 'pull_request' && event.action === 'merged') ||
        actions[event.event].safeParse(event.action).success),
  );
export const githubPendingPullRequestSchema = routing
  .extend({
    kind: z.literal('pull-request-required'),
    event: z.literal('issue_comment'),
    action: githubCommentActionSchema,
    fields: pendingFields,
  })
  .refine(
    event => event.fields['event.action'] === event.action && event.fields['pullRequest.number'] === event.number,
  );
export type GitHubNormalizedEvent = z.infer<typeof githubNormalizedEventSchema>;
export type GitHubPendingPullRequest = z.infer<typeof githubPendingPullRequestSchema>;
type Routing = z.infer<typeof routing>;
export type GitHubEventNormalization =
  | GitHubNormalizedEvent
  | GitHubPendingPullRequest
  | { kind: 'ignored'; reason: 'unsupported-event' | 'unsupported-action' | 'not-a-pull-request' };

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new GitHubEventError('event-invalid');
  return parsed.data;
}
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > githubEventInputByteLimit)
    throw new GitHubEventError('event-input-too-large');
  return value;
}
function pullFields(route: Routing, value: unknown) {
  const pull = parse(pullRequest, value);
  if (
    pull.base.repo.id !== route.repositoryId ||
    pull.number !== route.number ||
    pull.html_url !== `https://github.com/${route.repositoryName}/pull/${route.number}`
  ) {
    throw new GitHubEventError('event-context-mismatch');
  }
  return {
    'pullRequest.number': pull.number,
    'pullRequest.title': pull.title,
    'pullRequest.url': pull.html_url,
    'pullRequest.author': pull.user.login,
    'pullRequest.state': pull.merged_at !== null ? 'merged' : pull.state,
    'pullRequest.baseBranch': pull.base.ref,
    'pullRequest.headBranch': pull.head.ref,
  } as const;
}
function commentFields(route: Routing, value: unknown) {
  const comment = parse(z.object({ body: text, html_url: z.string() }), value);
  const root = `https://github.com/${route.repositoryName}`;
  const prefixes =
    route.event === 'issue_comment'
      ? [`${root}/pull/${route.number}#issuecomment-`, `${root}/issues/${route.number}#issuecomment-`]
      : [`${root}/pull/${route.number}#discussion_r`];
  if (
    !prefixes.some(prefix => comment.html_url.startsWith(prefix) && /^\d+$/.test(comment.html_url.slice(prefix.length)))
  ) {
    throw new GitHubEventError('event-context-mismatch');
  }
  return { 'comment.body': comment.body, 'comment.url': comment.html_url };
}

export function normalizeGitHubEvent(name: string, value: unknown): GitHubEventNormalization {
  const event = eventName.safeParse(name);
  if (!event.success) return { kind: 'ignored', reason: 'unsupported-event' };
  const action = parse(z.object({ action: z.string().max(64) }), value).action;
  const accepted = actions[event.data].safeParse(action);
  if (!accepted.success) return { kind: 'ignored', reason: 'unsupported-action' };
  const payload = parse(
    z.object({
      installation: z.object({ id: providerId }),
      repository,
      number: number.optional(),
      pull_request: z.unknown().optional(),
      issue: z.unknown().optional(),
      review: z.unknown().optional(),
      comment: z.unknown().optional(),
    }),
    value,
  );
  const repo = payload.repository;
  if (repo.html_url !== `https://github.com/${repo.full_name}`) throw new GitHubEventError('event-context-mismatch');
  const common = {
    installationId: payload.installation.id,
    repositoryId: repo.id,
    repositoryName: repo.full_name,
    ownerId: repo.owner.id,
    ownerKind: repo.owner.type === 'Organization' ? 'organization' : 'user',
    privateRepository: repo.private,
    event: event.data,
    action: accepted.data,
  } as const;
  const fields = { 'repository.name': repo.full_name, 'repository.url': repo.html_url, 'event.action': accepted.data };
  if (event.data === 'issue_comment') {
    const issue = parse(z.object({ number, pull_request: z.object({ url: z.string() }).optional() }), payload.issue);
    if (!issue.pull_request) return { kind: 'ignored', reason: 'not-a-pull-request' };
    if (issue.pull_request.url !== `https://api.github.com/repos/${repo.full_name}/pulls/${issue.number}`) {
      throw new GitHubEventError('event-context-mismatch');
    }
    const context = parse(z.object({ title: text, html_url: z.string(), user: identity }), payload.issue);
    if (context.html_url !== `https://github.com/${repo.full_name}/pull/${issue.number}`)
      throw new GitHubEventError('event-context-mismatch');
    const route = { ...common, number: issue.number };
    return bounded(
      parse(githubPendingPullRequestSchema, {
        ...route,
        kind: 'pull-request-required',
        fields: {
          ...fields,
          ...commentFields(route, payload.comment),
          'pullRequest.number': issue.number,
          'pullRequest.title': context.title,
          'pullRequest.url': context.html_url,
          'pullRequest.author': context.user.login,
        },
      }),
    );
  }
  const pull = parse(pullRequest, payload.pull_request);
  if (payload.number !== undefined && payload.number !== pull.number)
    throw new GitHubEventError('event-context-mismatch');
  const route = { ...common, number: pull.number };
  let normalizedAction: Routing['action'] = accepted.data;
  if (event.data === 'pull_request' && action === 'closed') {
    if (pull.merged === undefined || pull.state !== 'closed') throw new GitHubEventError('event-invalid');
    normalizedAction = pull.merged ? 'merged' : 'closed';
  }
  const review =
    event.data === 'pull_request_review'
      ? parse(
          z.object({
            state: z.enum(['commented', 'changes_requested', 'approved', 'dismissed']),
            body: text.nullable(),
            pull_request_url: z.string(),
          }),
          payload.review,
        )
      : null;
  if (review && review.pull_request_url !== `https://api.github.com/repos/${repo.full_name}/pulls/${pull.number}`) {
    throw new GitHubEventError('event-context-mismatch');
  }
  return bounded(
    parse(githubNormalizedEventSchema, {
      ...route,
      kind: 'event',
      action: normalizedAction,
      fields: {
        ...fields,
        ...pullFields(route, payload.pull_request),
        'event.action': normalizedAction,
        ...(review
          ? { 'review.state': review.state, ...(review.body === null ? {} : { 'review.body': review.body }) }
          : {}),
        ...(event.data === 'pull_request_review_comment' ? commentFields(route, payload.comment) : {}),
      },
    }),
  );
}

export function completeGitHubPullRequestEvent(
  input: GitHubPendingPullRequest,
  response: unknown,
): GitHubNormalizedEvent {
  const pending = parse(githubPendingPullRequestSchema, input);
  return bounded(
    parse(githubNormalizedEventSchema, {
      ...pending,
      kind: 'event',
      fields: { ...pullFields(pending, response), ...pending.fields },
    }),
  );
}
export const githubEventFilterSchema = z.strictObject({
  repositories: githubRepositorySelectionSchema,
  events: githubEventSelectionSchema,
  baseBranches: githubBranchSelectionSchema,
  headBranches: githubBranchSelectionSchema,
});
/** Filtering is not authorization; callers must separately verify the signature and current source access. */
export function matchesGitHubEvent(event: GitHubNormalizedEvent, filter: z.infer<typeof githubEventFilterSchema>) {
  const scope = filter.repositories;
  if (
    scope.kind === 'repositories'
      ? !scope.repositoryIds.includes(event.repositoryId)
      : event.ownerKind !== 'organization' || scope.organizationId !== event.ownerId
  )
    return false;
  if (
    !filter.events.some(
      choice => choice.event === event.event && choice.actions.some(action => action === event.action),
    )
  )
    return false;
  return (
    (filter.baseBranches.kind === 'all' ||
      filter.baseBranches.names.includes(event.fields['pullRequest.baseBranch'])) &&
    (filter.headBranches.kind === 'all' || filter.headBranches.names.includes(event.fields['pullRequest.headBranch']))
  );
}

export type GitHubObservedHandle = {
  externalId: string;
  handle: string;
  displayName?: string | null;
};

const observedUserId = z.union([providerId, githubEventIdSchema]);
const observedDisplayNameControl = /\p{Cc}/u;
const observedUserPaths: readonly (readonly string[])[] = [
  ['sender'],
  ['pull_request', 'user'],
  ['pull_request', 'merged_by'],
  ['issue', 'user'],
  ['comment', 'user'],
  ['review', 'user'],
  ['pusher'],
];
const maxObservedCommits = 200;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readObservedDisplayName(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > 200 || observedDisplayNameControl.test(trimmed)) return undefined;
  return trimmed;
}

function parseObservedUser(value: unknown, allowUsername = false): GitHubObservedHandle | null {
  const user = objectRecord(value);
  if (!user) return null;
  if (typeof user.type === 'string' && user.type !== 'User') return null;
  const id = observedUserId.safeParse(user.id);
  if (!id.success) return null;
  const rawLogin = typeof user.login === 'string' ? user.login : allowUsername ? user.username : undefined;
  const handle = githubLoginSchema.safeParse(rawLogin);
  if (!handle.success) return null;
  const displayName = readObservedDisplayName(user.name);
  return {
    externalId: id.data,
    handle: handle.data,
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

export function extractGitHubObservedHandles(body: unknown): GitHubObservedHandle[] {
  const root = objectRecord(body);
  if (!root) return [];
  const seen = new Map<string, GitHubObservedHandle>();
  const record = (candidate: unknown, allowUsername = false) => {
    const parsed = parseObservedUser(candidate, allowUsername);
    if (!parsed) return;
    const existing = seen.get(parsed.externalId);
    if (!existing) {
      seen.set(parsed.externalId, parsed);
    } else if (existing.displayName == null && parsed.displayName != null) {
      existing.displayName = parsed.displayName;
    }
  };
  for (const path of observedUserPaths) {
    let cursor: unknown = root;
    for (const segment of path) {
      const next = objectRecord(cursor);
      if (!next) {
        cursor = undefined;
        break;
      }
      cursor = next[segment];
    }
    record(cursor);
  }
  if (Array.isArray(root.commits)) {
    for (const commit of root.commits.slice(0, maxObservedCommits)) {
      const entry = objectRecord(commit);
      if (entry) record(entry.author, true);
    }
  }
  return [...seen.values()];
}

export async function observeGitHubHandles(tx: IdentityTransaction, body: unknown, observedAt?: Date): Promise<number> {
  if (!hasMemberIdentities(tx)) return 0;
  let recorded = 0;
  for (const { externalId, handle } of extractGitHubObservedHandles(body)) {
    const outcome = await observeExternalHandle(tx, {
      provider: 'github',
      scope: identityProviders.github.defaultScope,
      externalId,
      handle,
      source: 'webhook',
      ...(observedAt ? { observedAt } : {}),
    });
    if (outcome === 'recorded') recorded++;
  }
  return recorded;
}
