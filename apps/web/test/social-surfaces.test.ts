import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement, type ReactElement } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import type * as Review from '../src/features/social/post-review.tsx';
import type * as Schedule from '../src/features/social/schedule.tsx';
import type * as Presentation from '../src/features/social/presentation.ts';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(() => server.close());
const { SocialPostReview } = (await server.ssrLoadModule('/src/features/social/post-review.tsx')) as typeof Review;
const { SocialScheduleView } = (await server.ssrLoadModule('/src/features/social/schedule.tsx')) as typeof Schedule;
const { reviewChoice, variantFields } = (await server.ssrLoadModule(
  '/src/features/social/presentation.ts',
)) as typeof Presentation;
const { postSchema, scheduleSchema } = await import('@tulipfarm/social/contracts');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = 'a'.repeat(64);
const now = new Date('2026-10-01T12:00:00Z');
const later = '2026-10-05T12:00:00.000Z';
const conversation = id(90);

function variant(n: number, content: object, fields: object = {}) {
  return {
    id: id(n),
    postId: id(1),
    revision: 1,
    channelId: id(100 + n),
    channelVersion: 1,
    target: null,
    content,
    publishAt: null,
    dueAt: null,
    state: 'awaiting-approval',
    step: null,
    blockedReason: null,
    recheckAt: null,
    platformRefs: {},
    platformPostId: null,
    permalink: null,
    receipts: [],
    ...fields,
  };
}
const linkedin = {
  platform: 'linkedin',
  text: 'Launch day.\n\nRead the notes.',
  media: [{ fileId: id(70), contentDigest: digest, role: 'primary', altText: 'The release banner' }],
  visibility: 'public',
};
const tiktok = {
  platform: 'tiktok',
  caption: 'Behind the scenes',
  media: [{ fileId: id(71), contentDigest: digest, role: 'primary' }],
};

function post(
  fields: { sources?: object; reviewChoices?: object[]; variants?: object[]; decision?: object | null } = {},
) {
  return postSchema.parse({
    id: id(1),
    origin: { kind: 'conversation', conversationId: conversation, messageId: id(91) },
    authorMembershipId: id(80),
    currentRevision: 1,
    revisions: [
      {
        postId: id(1),
        number: 1,
        contentDigest: digest,
        sources: fields.sources ?? {
          dependencies: [{ kind: 'private-conversation', conversationId: conversation }],
          mcpDerived: false,
          privateTaskDerived: false,
        },
        reviewChoices: fields.reviewChoices ?? [],
        expiresAt: later,
        decision: fields.decision ?? null,
        variants: fields.variants ?? [variant(2, linkedin)],
      },
    ],
  });
}
const channels = [
  {
    id: id(102),
    accountId: id(60),
    platform: 'linkedin',
    channelKind: 'linkedin-member',
    platformChannelId: 'member-1',
    displayName: 'Ada on LinkedIn',
    accountGeneration: 1,
    version: 1,
    enabled: true,
    engagementPolicy: 'approve-each',
    grants: { publish: { memberIds: [], teamIds: [] }, manage: { memberIds: [id(80)], teamIds: [] } },
  },
] as never;

// Links in the card need a router; a bare root route is enough to render their hrefs.
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ['/'] }) });
const withRouter = (element: ReactElement) => createElement(RouterContextProvider, { router }, element);

const review = (props: Partial<Parameters<typeof SocialPostReview>[0]>) =>
  renderToStaticMarkup(
    withRouter(
      createElement(SocialPostReview, {
        post: post(),
        channels,
        slug: 'acme',
        now,
        sending: false,
        error: null,
        onDecide: () => {},
        ...props,
      }),
    ),
  );

test('PRODUCT 38: the review card shows every variant exactly as it will publish, with its sources', () => {
  const html = review({});
  assert.match(html, /Publish to 1 channel/);
  assert.match(html, /Ada on LinkedIn/);
  // The text is shown unchanged, line breaks included.
  assert.match(html, /Launch day\.\n\nRead the notes\./);
  assert.match(html, /The release banner/);
  assert.match(html, /When approved/);
  assert.match(html, /This chat/);
  assert.match(html, /Approve and publish/);
  assert.match(html, /Reject/);
  assert.match(html, new RegExp(digest));
  assert.deepEqual(
    variantFields(linkedin as never).map(field => [field.label, field.value]),
    [
      ['Text', linkedin.text],
      ['Visibility', 'public'],
    ],
  );
});

test('PRODUCT 20: sources that may not leave the workspace block approval on the card', () => {
  const html = review({
    post: post({
      sources: {
        dependencies: [{ kind: 'private-conversation', conversationId: conversation }],
        mcpDerived: true,
        privateTaskDerived: false,
      },
    }),
  });
  assert.match(html, /MCP connection output, which may not leave the workspace/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Approve and publish/);
});

test('PRODUCT 17: TikTok choices start unset and only a complete set from the creator’s options approves', () => {
  const entry = { variantId: id(3), platform: 'tiktok', required: ['privacy', 'allowComments'], values: null };
  const withTikTok = post({ variants: [variant(3, tiktok)], reviewChoices: [entry] });
  // Without the creator's current options the card cannot offer the choices, so it cannot be approved.
  const blocked = review({ post: withTikTok });
  assert.match(blocked, /needs choices only you can make/);
  assert.match(blocked, /<button[^>]*disabled=""[^>]*>Approve and publish/);

  const creatorInfo = {
    nickname: 'ada',
    maxVideoPostDurationSec: 600,
    privacyLevelOptions: ['SELF_ONLY', 'FOLLOWER_OF_CREATOR'] as const,
    commentDisabled: false,
    duetDisabled: true,
    stitchDisabled: false,
  };
  const offered = review({
    post: withTikTok,
    creatorInfo: { [id(3)]: { ...creatorInfo, privacyLevelOptions: [...creatorInfo.privacyLevelOptions] } },
  });
  assert.match(offered, /Nothing is preselected/);
  assert.match(offered, /Only me/);
  assert.match(offered, /Followers/);
  assert.doesNotMatch(offered, /Everyone/);
  // Only the option the creator turned off is set, and it is set to no.
  assert.equal(offered.match(/aria-checked="true"/g)?.length, 1);
  assert.match(offered, /Turned off by the creator/);
  assert.match(offered, /<button[^>]*disabled=""[^>]*>Approve and publish/);

  const info = { ...creatorInfo, privacyLevelOptions: [...creatorInfo.privacyLevelOptions] };
  assert.equal(reviewChoice(id(3), {}, info), null);
  assert.equal(reviewChoice(id(3), { privacy: 'SELF_ONLY', allowComments: true, allowStitch: false }, info), null);
  // A privacy level the creator does not offer is refused.
  assert.equal(
    reviewChoice(
      id(3),
      { privacy: 'PUBLIC_TO_EVERYONE', allowComments: true, allowStitch: false, disclosed: false },
      info,
    ),
    null,
  );
  const complete = reviewChoice(
    id(3),
    { privacy: 'SELF_ONLY', allowComments: true, allowStitch: false, disclosed: false },
    info,
  );
  assert.equal(complete?.values.allowDuet, false);
  assert.equal(complete?.values.privacy, 'SELF_ONLY');
});

test('PRODUCT 38: a decided or expired revision offers no decision', () => {
  const decided = review({
    post: post({
      variants: [variant(2, linkedin, { state: 'scheduled' })],
      decision: {
        id: id(50),
        postId: id(1),
        revision: 1,
        batchDigest: digest,
        decision: 'approve',
        deciderMembershipId: id(80),
        decidedAt: '2026-10-01T11:00:00.000Z',
      },
    }),
  });
  assert.match(decided, /Approved/);
  assert.doesNotMatch(decided, /Approve and publish/);
  const expired = review({ now: new Date('2026-10-06T00:00:00Z') });
  assert.match(expired, /This review expired/);
  assert.doesNotMatch(expired, /Approve and publish/);
});

const receipt = (fields: object) => ({
  id: id(40),
  variantId: id(4),
  revision: 1,
  decisionId: id(50),
  step: 'create-post',
  attemptId: id(41),
  status: 'succeeded',
  startedAt: '2026-10-01T11:00:00.000Z',
  settledAt: '2026-10-01T11:00:01.000Z',
  platformRefs: {},
  platformPostId: 'urn:li:share:1',
  platformRequestId: 'req-1',
  error: null,
  ...fields,
});
const scheduled = (n: number, fields: object) => ({
  postId: id(1),
  currentRevision: 1,
  authorMembershipId: id(80),
  variant: variant(n, linkedin, { channelId: id(102), ...fields }),
});
const actions = {
  resume: async () => undefined,
  cancel: async () => undefined,
  candidates: async () => ({ kind: 'unknown' as const }),
  settle: async () => undefined,
};

test('PRODUCT 39: the schedule lists scheduled, blocked, published, failed and unknown variants by channel', () => {
  const schedule = scheduleSchema.parse({
    channels: [
      {
        channelId: id(102),
        platform: 'linkedin',
        displayName: 'Ada on LinkedIn',
        variants: [
          scheduled(4, { state: 'scheduled', publishAt: later, dueAt: later }),
          scheduled(5, { state: 'blocked', blockedReason: 'grant-removed' }),
          scheduled(6, { state: 'blocked', blockedReason: 'daily-cap', recheckAt: later }),
          scheduled(7, {
            state: 'published',
            platformPostId: 'urn:li:share:1',
            permalink: 'https://www.linkedin.com/feed/update/urn:li:share:1',
            receipts: [receipt({ variantId: id(7) })],
          }),
          scheduled(8, {
            state: 'failed',
            receipts: [
              receipt({
                variantId: id(8),
                status: 'failed',
                platformPostId: null,
                error: { class: 'rejected', code: 'duplicate' },
              }),
            ],
          }),
          scheduled(9, {
            state: 'outcome-unknown',
            receipts: [
              receipt({
                variantId: id(9),
                status: 'outcome-unknown',
                platformPostId: null,
                error: { class: 'unknown', code: 'timeout' },
              }),
            ],
          }),
        ],
      },
    ],
    truncated: false,
  });
  const html = renderToStaticMarkup(createElement(SocialScheduleView, { schedule, actions }));
  assert.match(html, /Ada on LinkedIn/);
  for (const label of ['Scheduled', 'Blocked', 'Published', 'Failed', 'Outcome unknown'])
    assert.match(html, new RegExp(label));
  assert.match(html, /The publish grant on this channel was removed/);
  assert.match(html, /daily limit was reached\. It is checked again automatically/);
  // A blocked variant waiting on a person can be resumed or cancelled; a temporary block only cancelled.
  assert.equal(html.match(/>Resume</g)?.length, 1);
  assert.equal(html.match(/>Cancel variant</g)?.length, 2);
  assert.match(html, /View the published post/);
  assert.match(html, /Receipts \(1\)/);
  // PRODUCT 24: an unknown outcome is never retried; a person checks the platform and confirms.
  assert.match(html, /will not try again/);
  assert.match(html, /Check the platform/);
});

test('PRODUCT 39: an empty schedule says how to start', () => {
  const html = renderToStaticMarkup(
    createElement(SocialScheduleView, { schedule: { channels: [], truncated: false }, actions }),
  );
  assert.match(html, /Nothing scheduled or published yet/);
});
