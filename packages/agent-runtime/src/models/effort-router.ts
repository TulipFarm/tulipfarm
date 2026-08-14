import { createHash } from "node:crypto";
import { type EffortRung, isEffortRung } from "@tulipfarm/schema";
import { EFFORT_SIGNALS, promptFeatures } from "./effort-signals";

/**
 * A two-stage funnel that infers an effort rung from the prompt, for participants who asked for
 * `auto`.
 *
 * Stage 1 is a weighted sum over {@link EFFORT_SIGNALS} — free, synchronous, and **pure**, so a
 * replayed Run re-derives the identical score. It resolves most prompts outright.
 *
 * Stage 2 is a single call to the weakest configured rung, and runs *only* when stage 1 lands in
 * one of the narrow bands around a threshold. It is the expensive path, so it is also the rare one.
 *
 * Stage 2 is not reproducible, which matters here: routing in this codebase must replay to the same
 * answer or the audit record stops explaining the Run. The caller closes that gap by recording the
 * decision (see the `model.routed` Run event) and passing it back through `pinned` on any later
 * attempt — this module never calls the classifier when it is handed one.
 */

/**
 * Where a score falls. `unsure` is not a rung — it is the funnel admitting that the heuristic did
 * not separate this prompt, which is precisely when a second opinion is worth paying for.
 */
export type EffortBand = EffortRung | "unsure";

/**
 * The two zone boundaries, and the half-width of the ambiguous strip straddling each.
 *
 * Named because a threshold is the one thing in a router that will be tuned, and a number tuned in
 * place is a number nobody can find. Ambiguity sits at the *boundaries* rather than in the middle
 * of the `balanced` zone: a score dead-centre in `balanced` is the most confident `balanced` there
 * is, so spending a model call on it would buy nothing.
 *
 * Weights are on a 0.5 grid and the margin is 0.75, so every comparison here is exact in binary.
 */
export const EFFORT_FAST_THRESHOLD = -2;
export const EFFORT_THOROUGH_THRESHOLD = 3;
export const EFFORT_UNSURE_MARGIN = 0.75;

/**
 * What a malformed classifier answer resolves to.
 *
 * Never `fast` — that answers a hard question with a weak model, which is the failure the funnel
 * exists to avoid. Never `thorough` — a parser bug would then quietly bill every ambiguous turn at
 * the top rung. The middle rung is the only choice that fails in neither direction.
 */
export const EFFORT_CLASSIFIER_FALLBACK: EffortRung = "balanced";

/** The score and the signals that produced it. Both are needed to calibrate either one. */
export interface EffortScore {
  readonly score: number;
  readonly fired: readonly string[];
}

/**
 * The quick-tier model, as this module needs it: one prompt in, one word out.
 *
 * Injected rather than imported so the routing decision stays in this package while the provider,
 * the credential, and the process that holds them stay in the Worker.
 */
export interface EffortClassifierPort {
  classify(prompt: string): Promise<string>;
}

/** A routing decision, and every input needed to later argue it was wrong. */
export interface EffortRoutingDecision {
  readonly rung: EffortRung;
  readonly score: number;
  readonly firedSignals: readonly string[];
  readonly band: EffortBand;
  /** Whether stage 2 was paid for. */
  readonly usedClassifier: boolean;
  /**
   * SHA-256 of the scored text.
   *
   * The prompt itself never enters this record: it is durable, operator-visible evidence, and
   * routing records in this codebase carry reasons, never payloads. A hash still groups repeat
   * prompts and ties a complaint about one answer to the decision that produced it.
   */
  readonly promptHash: string;
  readonly classifierLatencyMs?: number;
}

/** Calibration hook. Wired now, consumed later — v1 ships no tuning loop. */
export type EffortRoutingLogger = (decision: EffortRoutingDecision) => void;

export interface EffortRouteOptions {
  /** Absent means stage 2 is unavailable; an `unsure` prompt then takes the safe middle rung. */
  readonly classifier?: EffortClassifierPort;
  readonly log?: EffortRoutingLogger;
  /** A decision already recorded for this turn. Present on a replay; suppresses stage 2 entirely. */
  readonly pinned?: EffortRoutingDecision;
  readonly now?: () => number;
}

/** The weighted sum, and which signals contributed to it. */
export function scoreEffortSignals(prompt: string): EffortScore {
  const features = promptFeatures(prompt);
  const fired: string[] = [];
  let score = 0;
  for (const signal of EFFORT_SIGNALS) {
    if (!signal.test(features)) continue;
    fired.push(signal.name);
    score += signal.weight;
  }
  return { score, fired };
}

/** The weighted sum alone. Use {@link scoreEffortSignals} when the reasons matter. */
export function scorePrompt(prompt: string): number {
  return scoreEffortSignals(prompt).score;
}

export function routeByScore(score: number): EffortBand {
  if (score <= EFFORT_FAST_THRESHOLD - EFFORT_UNSURE_MARGIN) return "fast";
  if (score < EFFORT_FAST_THRESHOLD + EFFORT_UNSURE_MARGIN) return "unsure";
  if (score <= EFFORT_THOROUGH_THRESHOLD - EFFORT_UNSURE_MARGIN) return "balanced";
  if (score < EFFORT_THOROUGH_THRESHOLD + EFFORT_UNSURE_MARGIN) return "unsure";
  return "thorough";
}

/**
 * Stage 2: one call, one word.
 *
 * Every way this can go wrong resolves to {@link EFFORT_CLASSIFIER_FALLBACK} — a wrong word, an
 * empty answer, a sentence of prose, a refusal, a timeout, a thrown provider error. The point of
 * the fallback is that the caller never has to distinguish them, so this function does not either.
 */
export async function classifyWithQuickModel(
  prompt: string,
  port: EffortClassifierPort
): Promise<EffortRung> {
  try {
    const answer = await port.classify(prompt);
    return readRung(answer);
  } catch {
    return EFFORT_CLASSIFIER_FALLBACK;
  }
}

/**
 * The label a one-word answer names, or the fallback.
 *
 * Punctuation and surrounding whitespace are tolerated because a model asked for one word still
 * emits `"balanced."` often enough to matter; anything longer than one word is not an answer to
 * the question that was asked and is not mined for a label hiding inside it.
 */
function readRung(answer: string): EffortRung {
  const word = answer
    .trim()
    .toLowerCase()
    .replace(/[.!,'"`]/g, "");
  return isEffortRung(word) ? word : EFFORT_CLASSIFIER_FALLBACK;
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

/**
 * Run the funnel.
 *
 * Stage 2 runs only for an `unsure` band, only when a classifier was supplied, and never when a
 * decision from an earlier attempt was pinned.
 */
export async function route(
  prompt: string,
  options: EffortRouteOptions = {}
): Promise<EffortRoutingDecision> {
  if (options.pinned !== undefined) {
    options.log?.(options.pinned);
    return options.pinned;
  }

  const { score, fired } = scoreEffortSignals(prompt);
  const band = routeByScore(score);
  const base = { score, firedSignals: fired, band, promptHash: hashPrompt(prompt) };

  if (band !== "unsure") {
    return record({ ...base, rung: band, usedClassifier: false }, options.log);
  }

  if (options.classifier === undefined) {
    return record(
      { ...base, rung: EFFORT_CLASSIFIER_FALLBACK, usedClassifier: false },
      options.log
    );
  }

  const now = options.now ?? Date.now;
  const startedAt = now();
  const rung = await classifyWithQuickModel(prompt, options.classifier);
  return record(
    { ...base, rung, usedClassifier: true, classifierLatencyMs: now() - startedAt },
    options.log
  );
}

function record(
  decision: EffortRoutingDecision,
  log: EffortRoutingLogger | undefined
): EffortRoutingDecision {
  log?.(decision);
  return decision;
}
