import { z } from 'zod';
import {
  channelSchema,
  decisionSubmitSchema,
  postSchema,
  reconcileResultSchema,
  scheduleSchema,
  settlementBodySchema,
  variantSchema,
  type DecisionReviewChoice,
  type Post,
  type VariantState,
} from '@tulipfarm/social/contracts';
import { apiOrigin } from './auth';
import { jsonResponse, readJson, requestSignal, responseError } from './http';

export type SocialChannel = z.infer<typeof channelSchema>;
export type SocialSchedule = z.infer<typeof scheduleSchema>;
export type SocialCandidates = z.infer<typeof reconcileResultSchema>;
export type SocialSettlement = z.infer<typeof settlementBodySchema>;

export class SocialRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const messages: Record<string, string> = {
  'revision-conflict': 'The post changed after you opened it. Review the current revision before deciding.',
  'revision-expired': 'This review expired. Ask chat to prepare the post again.',
  'post-conflict': 'This post was already decided differently. Refresh to see its outcome.',
  'variant-invalid': 'A variant no longer passes its channel’s checks, so the post cannot be approved.',
  'source-blocked':
    'The post uses content that may not leave the workspace, such as MCP output or a private task result.',
  'source-unreadable': 'You cannot read every source or media file of this post, so you cannot approve it.',
  'review-choices-invalid': 'Make every required choice from the options the platform currently offers.',
  'channel-unavailable': 'A channel is unavailable or you no longer hold its publish grant.',
  'channel-conflict': 'A channel changed after the post was prepared. Ask chat to prepare it again.',
  'account-reconnect-required': 'A connected account needs reconnecting before this can continue.',
  'variant-conflict': 'The variant’s state changed. Refresh the schedule and try again.',
  'variant-not-found': 'This variant is unavailable or you no longer hold its publish grant.',
  'settlement-unconfirmed':
    'The platform no longer lists that post as a candidate. Check the platform, then refresh the candidates.',
};

/** Words for a refusal; unknown outcomes never claim that nothing happened. */
export function socialError(error: unknown) {
  if (error instanceof SocialRequestError) {
    const known = messages[error.code];
    if (known) return known;
    if (error.status === 401) return 'Your session expired. Sign in again.';
    if (error.status === 403 || error.status === 404) return 'This post is unavailable to you.';
    if (error.status === 400) return 'The request was rejected. Refresh and try again.';
    if (error.status === 409) return 'The saved state changed. Refresh before continuing.';
  }
  return 'The response could not be confirmed. Refresh to check the saved state before trying again.';
}

async function request<T>(
  workspaceId: string,
  path: string,
  schema: z.ZodType<T>,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
) {
  const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/social${path}`, {
    method,
    body,
    cache: 'no-store',
    signal: requestSignal(signal),
  });
  const value = await readJson(response, !response.ok);
  if (!response.ok) throw new SocialRequestError(response.status, responseError(value, 'unavailable'));
  return schema.parse(value);
}

const id = (value: string) => encodeURIComponent(z.uuid().parse(value));

export const socialApi = {
  post: (workspaceId: string, postId: string, signal?: AbortSignal) =>
    request(workspaceId, `/posts/${id(postId)}`, postSchema, 'GET', undefined, signal),
  channels: (workspaceId: string, signal?: AbortSignal) =>
    request(workspaceId, '/channels', z.array(channelSchema), 'GET', undefined, signal),
  /** Approves or rejects the exact revision the card shows; a changed revision or digest is refused. */
  decide: (
    workspaceId: string,
    post: Post,
    decision: 'approve' | 'reject',
    reviewChoices: DecisionReviewChoice[] = [],
  ) => {
    const revision = post.revisions.find(item => item.number === post.currentRevision);
    if (!revision) throw new SocialRequestError(409, 'revision-conflict');
    return request(
      workspaceId,
      `/posts/${id(post.id)}/decision`,
      postSchema,
      'POST',
      decisionSubmitSchema.parse({
        postId: post.id,
        expectedRevision: revision.number,
        contentDigest: revision.contentDigest,
        decision,
        ...(decision === 'approve' && reviewChoices.length ? { reviewChoices } : {}),
      }),
    );
  },
  schedule: (workspaceId: string, query: { channelId?: string; states?: VariantState[] }, signal?: AbortSignal) => {
    const search = new URLSearchParams();
    if (query.channelId) search.set('channelId', query.channelId);
    if (query.states?.length) search.set('states', query.states.join(','));
    const suffix = search.size ? `?${search}` : '';
    return request(workspaceId, `/schedule${suffix}`, scheduleSchema, 'GET', undefined, signal);
  },
  resume: (workspaceId: string, variantId: string) =>
    request(workspaceId, `/variants/${id(variantId)}/resume`, variantSchema, 'POST', { expectedState: 'blocked' }),
  cancel: (workspaceId: string, variantId: string) =>
    request(workspaceId, `/variants/${id(variantId)}/cancel`, variantSchema, 'POST', { expectedState: 'blocked' }),
  candidates: (workspaceId: string, variantId: string, signal?: AbortSignal) =>
    request(workspaceId, `/variants/${id(variantId)}/candidates`, reconcileResultSchema, 'GET', undefined, signal),
  settle: (workspaceId: string, variantId: string, settlement: SocialSettlement) =>
    request(
      workspaceId,
      `/variants/${id(variantId)}/settlement`,
      variantSchema,
      'POST',
      settlementBodySchema.parse(settlement),
    ),
};
