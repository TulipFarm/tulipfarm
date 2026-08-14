import { createHash } from "node:crypto";
import { type EffortRung, isEffortRung } from "@tulipfarm/schema";
import { EFFORT_SIGNALS, promptFeatures } from "./effort-signals";

/** Pure two-stage effort router; classifier is used only near thresholds and never on replay. */

/** `unsure` means the heuristic should ask the classifier. */
export type EffortBand = EffortRung | "unsure";

/** Tunable score thresholds; ambiguity lives only around boundaries. */
export const EFFORT_FAST_THRESHOLD = -2;
export const EFFORT_THOROUGH_THRESHOLD = 3;
export const EFFORT_UNSURE_MARGIN = 0.75;

/** Malformed classifier output falls back to the safe middle rung. */
export const EFFORT_CLASSIFIER_FALLBACK: EffortRung = "balanced";

export interface EffortScore {
  readonly score: number;
  readonly fired: readonly string[];
}

/** Injected quick-tier classifier; this package must not import providers. */
export interface EffortClassifierPort {
  classify(prompt: string): Promise<string>;
}

export interface EffortRoutingDecision {
  readonly rung: EffortRung;
  readonly score: number;
  readonly firedSignals: readonly string[];
  readonly band: EffortBand;
  /** Whether stage 2 was paid for. */
  readonly usedClassifier: boolean;
  /** Persist only `promptHash`, never prompt text. */
  readonly promptHash: string;
  readonly classifierLatencyMs?: number;
}

export type EffortRoutingLogger = (decision: EffortRoutingDecision) => void;

export interface EffortRouteOptions {
  readonly classifier?: EffortClassifierPort;
  readonly log?: EffortRoutingLogger;
  readonly pinned?: EffortRoutingDecision;
  readonly now?: () => number;
}

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

/** Classifier failures all resolve to the safe fallback rung. */
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

/** Accept one punctuated word only; prose falls back. */
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

/** Run the funnel; stage 2 is only for unpinned `unsure` decisions. */
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
