import {
  DISTILL_TIMEOUT_MS,
  type DistilledResult,
  type DistillRequest,
  type ModelRequirements,
  type ModelRequirementsPolicy,
  type ToolResultDistillerPort,
} from "@tulipfarm/agent-runtime";
import { generateText } from "ai";
import {
  type BuiltInAgentModelSource,
  type BuiltInAgentSpec,
  builtInAgentRequirements,
} from "../../agent";
import { withDeadline } from "../../deadline";
import { untrusted } from "../../untrusted";
import { groundedCitations, parsed } from "./grounding";
import { DISTILLER_SYSTEM_PROMPT, distillerPrompt } from "./prompt";

/**
 * Summarises an oversized Tool result on the cheapest configured model.
 *
 * This is the intermediary the Tools deliberately do not contain. `web_fetch` and `api_request`
 * return whole, unedited responses so they stay deterministic and replayable; the judgement about
 * which parts matter happens here, once, against what the Turn actually asked.
 *
 * Everything it reads is untrusted by construction — a fetched page or a third party's JSON — so
 * the content travels fenced and labelled, and the model is told to treat instructions inside it
 * as data to report rather than commands to follow.
 */
export const TOOL_RESULT_DISTILLER: BuiltInAgentSpec = {
  id: "tool_result_distiller",
  purpose: "Summarise one oversized Tool result against what the Turn asked, with grounded quotes.",
  // Never the expensive model the Turn itself is using: this is a reading task on bytes the Turn
  // has already paid to fetch.
  rung: "fast",
  // Enough for a paragraph and a handful of quotes, not enough to reproduce the page.
  maxOutputTokens: 900,
  // Owned by the Tool loop, which holds the Turn's deadline and passes the signal in. Recorded
  // here so every BuiltInAgent's ceiling is readable in one place.
  timeoutMs: DISTILL_TIMEOUT_MS,
};

/** What the summariser is shown. Above this the tail is dropped rather than the call refused. */
const DISTILLER_MAX_CONTENT_CHARS = 120_000;

/** Which Turn to charge. Without it this call would be the unattributed spend the design forbids. */
export interface DistillerAttribution {
  readonly conversationId?: string;
  readonly runId?: string;
}

export interface ToolResultDistillerOptions<TGate = never> {
  readonly models: BuiltInAgentModelSource<TGate>;
  readonly log?: { warn(obj: unknown, msg?: string): void };
  /**
   * Where this call is reported as spend.
   *
   * The whole case for summarising outside the Tool is that the model work becomes visible and
   * chargeable. A distiller wired without this keeps the Tool deterministic and still makes the
   * unlogged, unattributed model call that the Tool-summarises design was rejected for.
   */
  readonly spend?: { recordLlmCall(record: DistillerCallRecord): void };
  /** Shared with the Turn's own model, so one provider outage is not retried twice over. */
  readonly gate?: TGate;
  readonly attribution?: DistillerAttribution;
}

export interface DistillerCallRecord {
  readonly conversationId?: string;
  readonly runId?: string;
  readonly model?: string;
  readonly tier?: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly durationMs?: number;
  readonly status: "ok" | "error";
}

export function createToolResultDistiller<TGate = never>(
  options: ToolResultDistillerOptions<TGate>
): ToolResultDistillerPort {
  return {
    async distill(
      request: DistillRequest,
      signal: AbortSignal
    ): Promise<DistilledResult | undefined> {
      const content = request.content.slice(0, DISTILLER_MAX_CONTENT_CHARS);
      const startedAt = Date.now();
      let modelId: string | undefined;
      let text: string;
      try {
        const model = await withDeadline(
          options.models.model(
            TOOL_RESULT_DISTILLER.rung,
            distillerRequirements(request.policy),
            options.gate
          ),
          signal
        );
        modelId = typeof model === "string" ? model : model.modelId;
        const generated = await generateText({
          model,
          system: DISTILLER_SYSTEM_PROMPT,
          prompt: distillerPrompt(request.toolName, request.ask, content),
          maxOutputTokens: TOOL_RESULT_DISTILLER.maxOutputTokens,
          abortSignal: signal,
        });
        text = generated.text;
        options.spend?.recordLlmCall({
          ...options.attribution,
          status: "ok",
          tier: TOOL_RESULT_DISTILLER.rung,
          durationMs: Date.now() - startedAt,
          ...(modelId === undefined ? {} : { model: modelId }),
          usage: {
            inputTokens: generated.usage?.inputTokens ?? 0,
            outputTokens: generated.usage?.outputTokens ?? 0,
          },
        });
      } catch (error) {
        // Never thrown onward: the Tool already succeeded, and a summariser outage must leave the
        // caller with a truncated raw result rather than fail a Turn that has done real work.
        options.log?.warn(
          { event: "tool_result_distiller.failed", toolName: request.toolName, err: error },
          "tool result distillation failed"
        );
        // A failed provider call still consumed a request, so it is reported. A cost view that
        // only counts successes understates exactly the deployments that are struggling.
        options.spend?.recordLlmCall({
          ...options.attribution,
          status: "error",
          tier: TOOL_RESULT_DISTILLER.rung,
          durationMs: Date.now() - startedAt,
          ...(modelId === undefined ? {} : { model: modelId }),
        });
        return undefined;
      }

      const value = parsed(text);
      const summary = typeof value?.summary === "string" ? value.summary.trim() : "";
      if (summary.length === 0) return undefined;

      const caveat = typeof value?.caveat === "string" ? value.caveat.trim() : "";
      return {
        summary: caveat.length === 0 ? summary : `${summary}\n\nCaveat: ${caveat}`,
        citations: groundedCitations(value?.citations, content),
      };
    },
  };
}

/** The Turn's governance, narrowed to what this call actually needs. */
export function distillerRequirements(policy: ModelRequirementsPolicy): ModelRequirements {
  return builtInAgentRequirements(policy, TOOL_RESULT_DISTILLER, DISTILLER_MAX_CONTENT_CHARS);
}
