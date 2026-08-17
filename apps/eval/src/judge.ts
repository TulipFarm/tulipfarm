import type { ProviderEntry } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import { generateText, type LanguageModel } from "ai";
import type { CreateModelFn } from "./model.ts";
import { JudgeError, type Judgement, parseJudgement } from "./rubric.ts";

/**
 * The Judge's identity, read from the environment.
 *
 * A third vendor, distinct from both seats under test, because a model grading its own homework
 * scores itself generously and the bias is invisible in the result. Held in the environment rather
 * than in `PINNED_MODELS` because the Judge is not a model a Sweep may be run *against* — mixing
 * the two lists is how a seat ends up grading itself.
 */
export interface JudgeIdentity {
  readonly baseUrl: string;
  readonly model: string;
}

export const JUDGE_ENV = {
  baseUrl: "EVAL_JUDGE_BASE_URL",
  model: "EVAL_JUDGE_MODEL",
  apiKey: "EVAL_JUDGE_API_KEY",
} as const;

/** The vendors already under test. A Judge pointed at one of these is grading its own homework. */
const SEAT_HOSTS = ["anthropic.com", "openai.com"];

/**
 * Read the Judge from the environment, or `undefined` when none is configured.
 *
 * Absent is a first-class answer, not an error. This deployment reaches its two models through
 * vendor CLI subscription seats and holds no API key at all, so a Judge is genuinely optional —
 * and a Corpus with no rubric Case needs none. What must never happen is a rubric Case silently
 * passing because no Judge was there to fail it; `requireJudge` is what enforces that.
 *
 * @throws {JudgeError} when the Judge is pointed at a vendor that is already under test.
 */
export function judgeIdentity(env: NodeJS.ProcessEnv = process.env): JudgeIdentity | undefined {
  const baseUrl = env[JUDGE_ENV.baseUrl];
  const model = env[JUDGE_ENV.model];
  if (baseUrl === undefined || model === undefined) return undefined;
  if (SEAT_HOSTS.some((host) => baseUrl.includes(host))) {
    throw new JudgeError(
      `${JUDGE_ENV.baseUrl} points at ${baseUrl}, a vendor already under test. A Judge must be a ` +
        `third vendor, or it grades its own homework and the bias never shows up in the result.`
    );
  }
  return { baseUrl, model };
}

/**
 * The string folded into the Corpus hash.
 *
 * Changing the Judge must invalidate every comparison as loudly as changing a Case does. Without
 * this a Judge swap would silently re-score history, and a Baseline would be compared against
 * numbers a different grader produced.
 */
export function judgeVersion(identity: JudgeIdentity | undefined): string {
  return identity === undefined ? "no-judge" : `${identity.baseUrl}|${identity.model}`;
}

/**
 * The provider entry for the Judge.
 *
 * `openai-compatible` is configuration, not a new adapter — the provider layer already builds this
 * from a base URL and a key. Built here rather than through `pinnedBinding` so the Judge gets its
 * own model instantiation: that path never passes the structured-outputs capability flag, so the
 * flag defaults off and JSON-schema mode is never requested of a Judge that may not support it.
 */
export function judgeEntry(identity: JudgeIdentity): ProviderEntry {
  return {
    provider: "openai-compatible",
    model: identity.model,
    base_url: identity.baseUrl,
    api_key_ref: `env://${JUDGE_ENV.apiKey}`,
  };
}

export interface Judge {
  readonly version: string;
  judge(prompt: string): Promise<Judgement>;
}

function unreachableSecrets(): SecretsService {
  const guard = {
    get: (): never => {
      throw new Error("the Judge must resolve its key from the environment, not stored secrets");
    },
  };
  return guard as unknown as SecretsService;
}

/**
 * A Judge backed by a real third-vendor model.
 *
 * Every failure — transport, empty reply, unparseable reply — leaves this as a thrown `JudgeError`
 * rather than a low score. A Judge that is down must read as an errored Trial, because a low score
 * would be indistinguishable from a genuine quality regression and would be acted on as one.
 */
export function createJudge(identity: JudgeIdentity, createModel: CreateModelFn): Judge {
  let client: Promise<LanguageModel> | undefined;
  return {
    version: judgeVersion(identity),
    judge: async (prompt) => {
      client ??= createModel(judgeEntry(identity), unreachableSecrets());
      let reply: string;
      try {
        const result = await generateText({ model: await client, prompt });
        reply = result.text;
      } catch (cause) {
        client = undefined;
        throw new JudgeError(`the Judge could not be reached: ${(cause as Error).message}`);
      }
      if (reply.trim() === "") throw new JudgeError("the Judge returned an empty reply");
      return parseJudgement(reply);
    },
  };
}
