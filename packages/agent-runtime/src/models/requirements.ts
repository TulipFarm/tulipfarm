import { contentText, type ModelModality, modalityForMediaType } from "@tulipfarm/schema";
import type { ModelInvocationRequest } from "../ports/model";
import type { ModelRequirements } from "./profile";

/** Pure request-derived model requirements; policy fields are merged verbatim. */

const CHARS_PER_TOKEN = 4;

const RESPONSE_HEADROOM_TOKENS = 1_024;

export type ModelRequirementsPolicy = Omit<
  ModelRequirements,
  "needsTools" | "needsStructuredOutput" | "estimatedContextTokens" | "sensitive"
> & {
  /** Sensitive work keeps caching off regardless of what the profile permits (SPEC §17). */
  readonly sensitive?: boolean;
};

export function estimateContextTokens(request: ModelInvocationRequest): number {
  const transcript = request.messages.reduce(
    (total, m) => total + contentText(m.content).length,
    0
  );
  const tools = (request.tools ?? []).reduce(
    (total, t) =>
      total + t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.inputSchema).length,
    0
  );
  const schema =
    request.outputSchema === undefined ? 0 : JSON.stringify(request.outputSchema).length;

  return (
    Math.ceil((transcript + tools + schema) / CHARS_PER_TOKEN) +
    (request.maxOutputTokens ?? RESPONSE_HEADROOM_TOKENS)
  );
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
    const modality = modalityForMediaType(file.mediaType);
    if (!modalities.includes(modality)) modalities.push(modality);
  }
  return modalities;
}
