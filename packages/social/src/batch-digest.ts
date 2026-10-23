import { canonical, digest } from '@tulipfarm/atlassian/operation-digest';
import type { DecisionReviewChoice, MediaItem, PlatformContent, Target } from './contracts.ts';

export type ContentDigestVariant = {
  channelId: string;
  channelVersion: number;
  target?: Target | null;
  content: PlatformContent;
  publishAt: string | null;
};

const media = ({ fileId, contentDigest, role, altText }: MediaItem) => ({ fileId, contentDigest, role, altText });
const byKey =
  <T>(key: (value: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

/** The canonical content digest input: one entry per variant, sorted by `channelId`. Review choices are not part of it. */
export function contentDigestInput(variants: readonly ContentDigestVariant[]) {
  return variants
    .map(variant => ({
      channelId: variant.channelId.toLowerCase(),
      channelVersion: variant.channelVersion,
      target: variant.target ?? null,
      content: { ...variant.content, media: variant.content.media.map(media) },
      publishAt: variant.publishAt,
    }))
    .sort(byKey(variant => variant.channelId));
}

export function canonicalContent(variants: readonly ContentDigestVariant[]): string {
  return canonical(contentDigestInput(variants));
}

/** SHA-256 hex of the canonical variants, fixed when the revision is written. */
export function contentDigest(variants: readonly ContentDigestVariant[]): string {
  return digest(contentDigestInput(variants));
}

/** The canonical batch digest input: the revision's content digest and the approved review choices by `variantId`. */
export function batchDigestInput(contentDigest: string, reviewChoices?: readonly DecisionReviewChoice[] | null) {
  return {
    contentDigest,
    reviewChoices: (reviewChoices ?? [])
      .map(choice => ({ variantId: choice.variantId.toLowerCase(), values: choice.values }))
      .sort(byKey(choice => choice.variantId)),
  };
}

/** SHA-256 hex that a decision stores, binding the content and the approved review choices together. */
export function batchDigest(contentDigest: string, reviewChoices?: readonly DecisionReviewChoice[] | null): string {
  return digest(batchDigestInput(contentDigest, reviewChoices));
}
