import { contentText, type ModelModality, modalityForMediaType } from "@tulipfarm/schema";
import type { ModelInvocationRequest, ResolvedAttachment } from "../ports/model";
import type { ModelRequirements } from "./profile";

/** Pure request-derived model requirements; policy fields are merged verbatim. */

const CHARS_PER_TOKEN = 4;

/**
 * The deployment-wide coarse token estimate: ~4 characters per token.
 *
 * Shared rather than re-derived so a ceiling expressed in tokens means the same thing wherever it
 * is enforced. It is an estimate, not a tokenizer — every ceiling that uses it is a budget, and a
 * budget that is 20% out is still a budget.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Characters a ceiling expressed in tokens permits, for cutting text to that ceiling. */
export function charsForTokens(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

const RESPONSE_HEADROOM_TOKENS = 1_024;
const IMAGE_TILE_PIXELS = 512;
const IMAGE_BASE_TOKENS = 85;
const IMAGE_TILE_TOKENS = 170;
const IMAGE_PIXELS_PER_TOKEN = 750;

export type ModelRequirementsPolicy = Omit<
  ModelRequirements,
  "needsTools" | "needsStructuredOutput" | "estimatedContextTokens" | "sensitive"
> & {
  /** Sensitive work keeps caching off regardless of what the profile permits (SPEC §17). */
  readonly sensitive?: boolean;
};

export function estimateContextTokens(request: ModelInvocationRequest): number {
  const usage = estimateModelUsage(request);
  return usage.inputTokens + usage.outputTokens;
}

/** Estimated provider-visible input and the configured output ceiling, kept separate for pricing. */
export function estimateModelUsage(request: ModelInvocationRequest): {
  readonly inputTokens: number;
  readonly outputTokens: number;
} {
  const transcript = request.messages.reduce(
    (total, m) => total + contentText(m.content).length,
    0
  );
  const attachmentTokens = (request.attachments ?? []).reduce(
    (total, file) => total + estimateAttachmentTokens(file),
    0
  );
  const tools = (request.tools ?? []).reduce(
    (total, t) =>
      total + t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.inputSchema).length,
    0
  );
  const schema =
    request.outputSchema === undefined ? 0 : JSON.stringify(request.outputSchema).length;

  return {
    inputTokens: Math.ceil((transcript + tools + schema) / CHARS_PER_TOKEN) + attachmentTokens,
    outputTokens: request.maxOutputTokens ?? RESPONSE_HEADROOM_TOKENS,
  };
}

/**
 * Conservative provider-input estimate for one resolved File.
 *
 * Converted documents count only the text actually sent. Images use the larger of common
 * pixel-area and tiled-image formulas. PDFs count their extracted text as a proxy for the
 * provider's document parsing plus the same visual estimate for every parsed page. The estimate
 * is intentionally provider-neutral: exact image and PDF metering remains provider-owned.
 */
export function estimateAttachmentTokens(file: ResolvedAttachment): number {
  const providerText = providerAttachmentText(file);
  if (providerText !== undefined) return estimateTokens(providerText);

  const extractedText = file.text === undefined ? 0 : estimateTokens(file.text);
  if (file.visual === undefined) {
    return hasUnknownAttachmentEstimate(file) ? Number.POSITIVE_INFINITY : extractedText;
  }
  if (file.visual.kind === "image") {
    return extractedText + estimateVisualTokens(file.visual.width, file.visual.height);
  }

  return (
    extractedText +
    file.visual.pages.reduce(
      (total, page) => total + estimateVisualTokens(page.width, page.height),
      0
    )
  );
}

export function hasUnknownAttachmentEstimate(file: ResolvedAttachment): boolean {
  if (
    providerAttachmentText(file) !== undefined ||
    file.text !== undefined ||
    file.visual !== undefined
  ) {
    return false;
  }
  return modalityForMediaType(file.mediaType) === "image" || file.mediaType === "application/pdf";
}

function estimateVisualTokens(width: number, height: number): number {
  const safeWidth = Math.max(1, Math.ceil(width));
  const safeHeight = Math.max(1, Math.ceil(height));
  const areaEstimate = Math.ceil((safeWidth * safeHeight) / IMAGE_PIXELS_PER_TOKEN);
  const tiledEstimate =
    IMAGE_BASE_TOKENS +
    IMAGE_TILE_TOKENS *
      Math.ceil(safeWidth / IMAGE_TILE_PIXELS) *
      Math.ceil(safeHeight / IMAGE_TILE_PIXELS);
  return Math.max(areaEstimate, tiledEstimate);
}

/** Text emitted for one resolved File, or `undefined` when the provider receives binary bytes. */
export function providerAttachmentText(file: ResolvedAttachment): string | undefined {
  if (
    modalityForMediaType(file.mediaType) === "image" ||
    file.mediaType === "application/pdf" ||
    file.text === undefined ||
    file.text.length === 0
  ) {
    return undefined;
  }
  return `${file.name}:\n\n${file.text}`;
}

/** Capability needed by the representation the adapter sends, not by the original MIME alone. */
export function providerInputModality(file: ResolvedAttachment): ModelModality {
  return providerAttachmentText(file) === undefined ? modalityForMediaType(file.mediaType) : "text";
}

export function deriveModelRequirements(
  request: ModelInvocationRequest,
  policy: ModelRequirementsPolicy = {}
): ModelRequirements {
  const { sensitive = false, ...governance } = policy;
  return {
    ...governance,
    inputModalities: inputModalitiesFor(request, policy.inputModalities),
    needsTools: (request.tools?.length ?? 0) > 0,
    needsStructuredOutput: request.outputSchema !== undefined,
    estimatedContextTokens: estimateContextTokens(request),
    sensitive,
  };
}

/**
 * What the turn's own content demands, unioned onto what policy already demanded.
 *
 * Derived from the resolved attachments rather than from the transcript's file parts, because
 * attachments are exactly what will be sent. A file part in an older Message resolves to nothing
 * and reaches no provider, so counting it would demand vision of every later Turn — one image
 * would pin the whole conversation to a vision model for good.
 *
 * It is `checkModelProfile` reading this that turns an unsupported modality into a refusal —
 * before any provider call — rather than a silent drop at the adapter.
 */
function inputModalitiesFor(
  request: ModelInvocationRequest,
  declared: readonly ModelModality[] | undefined
): readonly ModelModality[] {
  const modalities: ModelModality[] = [...(declared ?? ["text"])];
  for (const file of request.attachments ?? []) {
    const modality = providerInputModality(file);
    if (!modalities.includes(modality)) modalities.push(modality);
  }
  return modalities;
}
