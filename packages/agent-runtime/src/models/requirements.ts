import { contentText } from "@tulipfarm/schema";
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
    needsTools: (request.tools?.length ?? 0) > 0,
    needsStructuredOutput: request.outputSchema !== undefined,
    estimatedContextTokens: estimateContextTokens(request),
    sensitive,
  };
}
