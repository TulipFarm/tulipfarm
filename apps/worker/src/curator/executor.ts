import type { ModelRequirements } from "@tulipfarm/agent-runtime";
import {
  type BusinessPromptInput,
  buildBusinessCuratorPrompt,
  buildUserCuratorPrompt,
  type UserPromptInput,
} from "@tulipfarm/curator";
import {
  type ArtifactService,
  INVOKE_STATE_KEY,
  RUN_EXECUTOR_PRINCIPAL_REF,
  type RunSource,
  requestArtifactId,
} from "@tulipfarm/run-kernel";
import { CURATOR_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import type { PersistedRun, RunStore } from "@tulipfarm/storage";
import { reclaimPendingState, type StateTransitionPort } from "@tulipfarm/turn-executor";
import { generateText, type LanguageModel } from "ai";
import type { RunOutcome } from "../run-dispatcher";

/**
 * Executes one Curator Run: fetch the pinned context, reason once, hand the raw answer back.
 *
 * The Worker deliberately holds no judgement here. It never chooses which inputs the job may see,
 * never validates the model's answer and never applies anything — the API re-derives all of that
 * from the job's own manifest. Keeping the reasoning host dumb is what stops a buggy or
 * compromised Worker from widening what a job was allowed to touch.
 */

export const CURATOR_RUN_SOURCE: RunSource = "curator";

/** Reasoning over conversations, not architecture: the middle rung, never `auto`. */
const CURATOR_RUNG = "balanced";

/** Enough for several patches and proposals with citations; short of an essay. */
const CURATOR_MAX_OUTPUT_TOKENS = 4_000;

/** A stalled provider must not hold the job's reservation for the whole lease. */
const CURATOR_TIMEOUT_MS = 120_000;

const OUTPUT_INSTRUCTION =
  "Reply with a single JSON object and nothing else. No prose, no code fence.";

/** Resolves a selector to an executable model. Satisfied by `SoulLlm.model`. */
export interface CuratorModelSource {
  model(selector: string, requirements: ModelRequirements): Promise<LanguageModel>;
}

/** The slice of the internal API this executor speaks. Satisfied by `InternalApiClient`. */
export interface CuratorApiPort {
  require<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
}

export interface CuratorExecutorOptions {
  readonly api: CuratorApiPort;
  readonly models: CuratorModelSource;
  readonly artifacts: Pick<ArtifactService, "read">;
  readonly runs?: Pick<RunStore, "findState">;
  readonly transitions?: StateTransitionPort;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly log?: {
    info(message: string): void;
    warn?(obj: unknown, msg?: string): void;
    error?(message: string, error?: unknown): void;
  };
}

type ResolvedContext = Record<string, unknown> & {
  readonly scope?: string;
  readonly contextDigest?: string;
};

const CURATOR_REQUIREMENTS: ModelRequirements = {
  needsTools: false,
  // The API re-parses and re-validates whatever arrives, so demanding a provider-side structured
  // output mode would only deny the loop models it can in fact work with.
  needsStructuredOutput: false,
  estimatedContextTokens: 32_000,
  // Private conversations and one person's own memory document.
  sensitive: true,
  allowTraining: false,
  inputModalities: ["text"],
  outputModalities: ["text"],
};

export function createCuratorExecutor(
  options: CuratorExecutorOptions
): (run: PersistedRun, signal?: AbortSignal) => Promise<RunOutcome> {
  const { api, models, artifacts, runs, transitions, log } = options;
  const now = options.now ?? (() => new Date());

  return async (run, signal) => {
    let stateRunning = false;

    if (runs && transitions) {
      const state = await runs.findState(run.businessId, run.id, INVOKE_STATE_KEY);
      if (state !== null) {
        if (state.status === "pending") {
          await reclaimPendingState(transitions, {
            businessId: run.businessId,
            runId: run.id,
            stateKey: INVOKE_STATE_KEY,
          });
        }
        if (state.status === "pending" || state.status === "claimed") {
          await transitions.transition({
            businessId: run.businessId,
            runId: run.id,
            stateKey: INVOKE_STATE_KEY,
            from: "claimed",
            to: "running",
          });
          stateRunning = true;
        } else if (state.status === "running") {
          stateRunning = true;
        }
      }
    }

    try {
      const jobId = await jobIdOf(run, artifacts, now());
      if (!jobId) {
        if (transitions && stateRunning) {
          await transitions.transition({
            businessId: run.businessId,
            runId: run.id,
            stateKey: INVOKE_STATE_KEY,
            from: "running",
            to: "failed",
            reason: "missing_job_id",
          });
        }
        return { status: "failed", errorEvidenceRef: "curator:missing_job_id" };
      }

      const context = await api.require<ResolvedContext>(
        "GET",
        `/api/v1/internal/curator/jobs/${encodeURIComponent(jobId)}/context`
      );
      const { contextDigest } = context;
      if (typeof contextDigest !== "string" || contextDigest.length === 0) {
        if (transitions && stateRunning) {
          await transitions.transition({
            businessId: run.businessId,
            runId: run.id,
            stateKey: INVOKE_STATE_KEY,
            from: "running",
            to: "failed",
            reason: "missing_context_digest",
          });
        }
        return { status: "failed", errorEvidenceRef: "curator:missing_context_digest" };
      }

      const prompt =
        context.scope === "business"
          ? buildBusinessCuratorPrompt(businessInput(context))
          : buildUserCuratorPrompt(userInput(context));

      const model = await models.model(CURATOR_RUNG, CURATOR_REQUIREMENTS);
      const { text } = await generateText({
        model,
        prompt: `${prompt}

${OUTPUT_INSTRUCTION}`,
        maxOutputTokens: CURATOR_MAX_OUTPUT_TOKENS,
        abortSignal: boundedSignal(signal, options.timeoutMs ?? CURATOR_TIMEOUT_MS),
      });

      // Unparsable output is submitted as the raw string on purpose. The API records it as a
      // rejection against this job, so a model that cannot hold the contract shows up in the loop's
      // own metrics instead of vanishing into a Worker-side error.
      const result = await api.require<{ recorded: number; rejected: number }>(
        "POST",
        `/api/v1/internal/curator/jobs/${encodeURIComponent(jobId)}/effects`,
        { contextDigest, output: extractJson(text) ?? text }
      );
      log?.info(
        `curator job=${jobId} scope=${context.scope ?? "user"} recorded=${result.recorded} rejected=${result.rejected}`
      );

      if (transitions && stateRunning) {
        await transitions.transition({
          businessId: run.businessId,
          runId: run.id,
          stateKey: INVOKE_STATE_KEY,
          from: "running",
          to: "succeeded",
        });
      }

      return { status: "succeeded" };
    } catch (error) {
      log?.error?.(`curator run failed for runId=${run.id}`, error);
      if (transitions && stateRunning) {
        try {
          await transitions.transition({
            businessId: run.businessId,
            runId: run.id,
            stateKey: INVOKE_STATE_KEY,
            from: "running",
            to: "failed",
            reason: error instanceof Error ? error.message : "curator_execution_failed",
          });
        } catch {
          // Failure to transition state on error should still return "failed"
        }
      }
      // The exception message went to the State's own reason above; the Run-level evidence ref
      // stays a fixed, terse code so a provider or SDK error message never reaches this column.
      return { status: "failed", errorEvidenceRef: "curator:execution_failed" };
    }
  };
}

/**
 * The job id comes from the Run's own request Artifact, never from anything the Worker composed.
 * The schema ref is checked first, so a Run of some other kind can never be steered into the
 * Curator's gateway by reusing its source.
 */
async function jobIdOf(
  run: PersistedRun,
  artifacts: Pick<ArtifactService, "read">,
  now: Date
): Promise<string | undefined> {
  const artifact = await artifacts.read({
    businessId: run.businessId,
    artifactId: requestArtifactId(run.id),
    reader: RUN_EXECUTOR_PRINCIPAL_REF,
    allowedClassifications: [],
    now,
  });
  if (artifact.schemaRef !== CURATOR_REQUEST_SCHEMA_REF) return undefined;
  const jobId = (artifact.content as { jobId?: unknown }).jobId;
  return typeof jobId === "string" && jobId.length > 0 ? jobId : undefined;
}

/** Honours the dispatcher's shutdown signal and the provider bound, whichever fires first. */
function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function userInput(context: ResolvedContext): UserPromptInput {
  return {
    memoryDocument: str(context.memoryDocument),
    sectionCharsRemaining: (context.sectionCharsRemaining ?? {}) as Record<string, number>,
    turns: arr(context.turns) as UserPromptInput["turns"],
    subjects: arr(context.subjects) as UserPromptInput["subjects"],
    openProposalKeys: arr(context.openProposalKeys) as readonly string[],
    seeds: arr(context.seeds) as UserPromptInput["seeds"],
  };
}

function businessInput(context: ResolvedContext): BusinessPromptInput {
  return {
    soulSummary: str(context.soulSummary),
    candidates: arr(context.candidates) as BusinessPromptInput["candidates"],
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function arr(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Recovers the JSON object from output that arrived inside a fence or with trailing commentary.
 * Returns undefined rather than guessing when nothing parses, so the caller submits the raw text
 * and the rejection is recorded honestly.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  for (const candidate of [fenced?.[1], trimmed, sliceBraces(trimmed)]) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next shape; exhausting them all is the caller's "unparsable" signal.
    }
  }
  return undefined;
}

function sliceBraces(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}
