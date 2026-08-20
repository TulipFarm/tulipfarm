import type { ModelMessage, ModelOutput } from "@tulipfarm/agent-runtime";
import { extractText } from "@tulipfarm/files";
import type { CaseAttachment } from "./case.ts";
import type { EvalGuardrails } from "./guardrails.ts";

/**
 * Where the harness puts a guard, and what it feeds it.
 *
 * These mirror `TurnDriver` rather than wrap `EvalGuardrails`: the Corpus measures the product's
 * guard *placement* as much as the guards themselves, so a stage that drifts from production turns
 * every Case that depends on it into a test of a path no user takes.
 */

/** What the attachment port would have extracted, using the product's own extractor. */
export async function screenableText(
  attachments: readonly (CaseAttachment & { data: Uint8Array })[]
): Promise<string[]> {
  const texts = await Promise.all(
    attachments.map(async (each) => {
      const result = await extractText(each.mediaType, each.data);
      return result.kind === "text" ? result.text : undefined;
    })
  );
  return texts.filter((text) => text !== undefined);
}

/**
 * Guards the latest user message, as `TurnDriver.guardInput` does.
 *
 * Returns the guarded message list, not just the refusal: a guard may *transform* rather than
 * block, and discarding the transform would send the model text production would never have sent.
 *
 * `attachmentText` is what production's attachment port extracts before the guard runs. A Case
 * whose attack lives inside a File is only a real test if the harness screens what production
 * screens — otherwise the Corpus would score the model's judgement on a payload the product
 * would have blocked outright.
 */
export async function guardInput(
  guards: EvalGuardrails,
  input: readonly ModelMessage[],
  attachmentText: readonly string[]
): Promise<
  | { readonly blocked: true; readonly message: string }
  | { readonly blocked: false; readonly messages: readonly ModelMessage[] }
> {
  let index = input.length - 1;
  while (index >= 0 && input[index]?.role !== "user") index -= 1;
  const current = index < 0 ? undefined : input[index];
  if (current === undefined) return { blocked: false, messages: input };

  const guarded = await guards.input(current.content, attachmentText);
  if (guarded.blocked) return guarded;

  const messages = [...input];
  messages[index] = { role: current.role, content: guarded.content };
  return { blocked: false, messages };
}

/** Blocked answers are replaced by the guard's message, never dropped. */
export async function guardOutput(
  guards: EvalGuardrails,
  output: ModelOutput | undefined
): Promise<ModelOutput | undefined> {
  if (output?.kind !== "text") return output;
  const guarded = await guards.output(output.text);
  return guarded.blocked ? { kind: "text", text: guarded.message } : output;
}
