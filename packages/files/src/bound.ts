import type { BlobPort, BlobRef } from "@tulipfarm/storage";
import { type ImageSize, imageSize } from "./dimensions";
import { isImageMediaType } from "./limits";

/**
 * Bounding an image before it reaches a model.
 *
 * An unbounded image is not a cost edge case: at least one provider does not cap resolution on its
 * highest-detail setting, so a photo straight from a phone becomes many thousands of input tokens
 * on every iteration of the Tool loop, not just once.
 *
 * Refusing is the default and downscaling is opt-in, which is the opposite of what most products
 * do. A resize is a silent edit to what the person attached — the Agent then answers about a
 * picture nobody saw, and neither the person nor the operator is told. Refusing keeps the person
 * in the loop about their own evidence. An operator who would rather trade fidelity for reach
 * turns it on knowingly, per business, in `soul.yaml`.
 */

/**
 * Longest edge, in pixels, an image may have by default.
 *
 * 1568 is the largest long edge that at least one major vision provider will accept without
 * resizing on its own, so it is the widest bound that still guarantees the bytes we send are the
 * bytes that get looked at.
 */
export const DEFAULT_MAX_IMAGE_DIMENSION = 1_568;

export interface ImageBoundPolicy {
  /** Longest edge allowed; defaults to {@link DEFAULT_MAX_IMAGE_DIMENSION}. */
  readonly maxImageDimension?: number;
  /** When true an oversized image is downscaled to fit instead of refused. */
  readonly downscaleImages?: boolean;
}

export type ImageBoundOutcome =
  | {
      readonly kind: "accepted";
      readonly data: Uint8Array;
      readonly mediaType: string;
      /** Present only when the bytes were re-encoded, so a caller can say so. */
      readonly downscaledFrom?: ImageSize;
    }
  | { readonly kind: "refused"; readonly reason: string };

/** Formats jimp can re-encode losslessly enough to substitute for the original. */
const DOWNSCALABLE = new Set(["image/png", "image/jpeg"]);

/**
 * Bounds one attachment, given the business's policy.
 *
 * Non-images pass through: a PDF's cost is bounded by the byte cap the upload already enforced,
 * and there is no resize that means anything for one.
 */
export async function boundImage(
  data: Uint8Array,
  mediaType: string,
  policy: ImageBoundPolicy = {}
): Promise<ImageBoundOutcome> {
  if (!isImageMediaType(mediaType)) return { kind: "accepted", data, mediaType };

  const limit = policy.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION;
  const size = imageSize(data, mediaType);
  if (size === null) {
    // Unreadable dimensions are accepted rather than refused. The pixel cap exists to bound token
    // cost, and the upload byte cap already bounds that for anything whose header we cannot parse;
    // refusing here would instead reject valid images — a JPEG whose frame header sits behind an
    // unusually large EXIF block — for a cost problem they do not cause.
    return { kind: "accepted", data, mediaType };
  }
  if (Math.max(size.width, size.height) <= limit) {
    return { kind: "accepted", data, mediaType };
  }
  if (policy.downscaleImages !== true) {
    return {
      kind: "refused",
      reason: `This image is ${size.width}×${size.height}px, over the ${limit}px limit. Resize it, or ask an administrator to turn on automatic downscaling.`,
    };
  }
  if (!DOWNSCALABLE.has(mediaType)) {
    return {
      kind: "refused",
      reason: `This image is ${size.width}×${size.height}px, over the ${limit}px limit, and ${mediaType} cannot be downscaled automatically. Convert it to PNG or JPEG, or resize it.`,
    };
  }
  return downscale(data, mediaType, size, limit);
}

/**
 * Loaded on demand because the default policy never downscales, so most deployments must not pay
 * jimp's load cost to find that out.
 */
async function downscale(
  data: Uint8Array,
  mediaType: string,
  from: ImageSize,
  limit: number
): Promise<ImageBoundOutcome> {
  try {
    const { Jimp } = await import("jimp");
    const image = await Jimp.read(Buffer.from(data));
    image.scaleToFit({ w: limit, h: limit });
    const encoded = await image.getBuffer(mediaType as "image/png" | "image/jpeg");
    return {
      kind: "accepted",
      data: new Uint8Array(encoded),
      mediaType,
      downscaledFrom: from,
    };
  } catch {
    // A decode or encode failure means these bytes are not the image their header claims. The
    // original is still over the limit, so there is nothing to fall back to but a refusal.
    return {
      kind: "refused",
      reason: `This image is ${from.width}×${from.height}px, over the ${limit}px limit, and could not be downscaled because its contents could not be decoded.`,
    };
  }
}

/**
 * Applies the business's image policy to an object already in the blob store.
 *
 * Separate from `boundImage`, which decides about bytes: this one owns the consequences — reading
 * the object back only when a downscale is actually going to happen, replacing it, and discarding
 * whatever it orphaned. A refusal deletes the object it refused, so a rejected upload never leaves
 * bytes behind for a sweeper to find later.
 */
export async function boundStoredImage(
  blobs: BlobPort,
  ref: BlobRef,
  mediaType: string,
  sample: { bytes: Uint8Array; size: number },
  policy: ImageBoundPolicy,
  discard: (ref: BlobRef) => Promise<void>
): Promise<{ ref: BlobRef; sizeBytes: number; refused?: string }> {
  // The head carries the dimensions, so the common cases — inside the limit, or refused — decide
  // without reading the object back.
  const head = await boundImage(sample.bytes, mediaType, { ...policy, downscaleImages: false });
  if (head.kind === "accepted") return { ref, sizeBytes: sample.size };
  if (policy.downscaleImages !== true) {
    await discard(ref);
    return { ref, sizeBytes: sample.size, refused: head.reason };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of await blobs.get(ref)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const whole = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }

  const outcome = await boundImage(whole, mediaType, policy);
  if (outcome.kind === "refused") {
    await discard(ref);
    return { ref, sizeBytes: sample.size, refused: outcome.reason };
  }
  const replacement = await blobs.put(
    (async function* () {
      yield outcome.data;
    })(),
    mediaType
  );
  await discard(ref);
  return { ref: replacement, sizeBytes: outcome.data.byteLength };
}
