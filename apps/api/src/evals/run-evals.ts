import path from "node:path";
import type { ExposedTool, ToolDispatchPort } from "@tulipfarm/agent-runtime";
import {
  agentLoopTarget,
  type EvalRunReport,
  type EvalTarget,
  fileDatasetSource,
  fileSink,
  llmJudge,
  modelTarget,
  mustRefuse,
  notContainsForbidden,
  runEvals,
  type Scorer,
  toolCalledFromExpected,
} from "@tulipfarm/evals";
import { LlmService } from "@tulipfarm/llm";
import { config as loadEnv } from "dotenv";
import { LlmJudgeModel } from "./judge";
import { llmEvalModelPort } from "./live-target";

/*
 * On-demand / nightly live eval runner (`pnpm evals`).
 *
 * This is the live-wiring seam that Phase 2 turns into an API service + DB persistence. It runs the
 * REAL configured providers against the versioned datasets in `packages/evals/datasets`, applies
 * the multi-run pass-rate threshold, and writes JSON + Markdown reports to `eval-results/`. It is
 * NOT part of PR CI: it costs tokens, is nondeterministic, and needs provider credentials.
 *
 * Provider config comes from the environment so a dev needs no Soul checkout:
 *   EVAL_LIVE=1                      required, or the runner prints how to enable and exits 0
 *   EVAL_PROVIDER / LLM_PROVIDER     default "openai" (use "openai-compatible" for Ollama/local)
 *   EVAL_MODEL / LLM_MODEL           default per provider (e.g. "gemma3" on Ollama)
 *   EVAL_BASE_URL                    OpenAI-compatible base URL (Ollama: http://localhost:11434/v1)
 *   EVAL_API_KEY_ENV                 env var holding the key (default "LLM_API_KEY"); optional for local
 *   EVAL_RUNS                        samples per case (default from the harness: 3)
 */

const dir = __dirname;
const repoRoot = path.resolve(dir, "../../../..");
const datasetsDir = path.resolve(repoRoot, "packages/evals/datasets");
const outputDir = path.resolve(repoRoot, "eval-results");

loadEnv({ path: path.resolve(dir, "../../.env.local") });
loadEnv({ path: path.resolve(repoRoot, ".env") });

const EVAL_TOOLS: ExposedTool[] = [
  {
    name: "record_create",
    description: "Create a record or task with the given title.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "knowledge_search",
    description: "Search the knowledge base for relevant documents.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

/** Effects are stubbed: evals grade the DECISION to call a tool, never run a side effect. */
const stubDispatch: ToolDispatchPort = {
  async dispatch(request) {
    return { status: "succeeded", callId: request.callId, output: { ok: true } };
  },
};

function defaultModel(provider: string): string {
  return provider === "anthropic" ? "claude-3-5-haiku-latest" : "gpt-4o-mini";
}

interface LlmSetup {
  readonly config: unknown;
  readonly provider: string;
  readonly apiKeyEnv: string;
  readonly baseUrl?: string;
  /** Hosted providers need a key; a local OpenAI-compatible endpoint (e.g. Ollama) may not. */
  readonly requiresKey: boolean;
}

function buildLlmConfig(): LlmSetup {
  const provider = process.env.EVAL_PROVIDER ?? process.env.LLM_PROVIDER ?? "openai";
  const model = process.env.EVAL_MODEL ?? process.env.LLM_MODEL ?? defaultModel(provider);
  const apiKeyEnv = process.env.EVAL_API_KEY_ENV ?? "LLM_API_KEY";
  const baseUrl = process.env.EVAL_BASE_URL;
  const hasKey = Boolean(process.env[apiKeyEnv]);
  const entry = {
    provider,
    model,
    ...(baseUrl ? { base_url: baseUrl } : {}),
    ...(hasKey ? { api_key_ref: `env://${apiKeyEnv}` } : {}),
  };
  const tier = { providers: [entry] };
  return {
    config: { tiers: { quick: tier, standard: tier, complex: tier } },
    provider,
    apiKeyEnv,
    ...(baseUrl ? { baseUrl } : {}),
    // A local/OpenAI-compatible endpoint authenticates by URL, not a hosted key.
    requiresKey: !baseUrl && provider !== "openai-compatible",
  };
}

/** Minimal SecretsService stand-in: env:// key refs never touch it, and nothing else is used here. */
const NO_SECRETS = {
  async get() {
    throw new Error("eval runner resolves keys from env:// refs only");
  },
} as unknown as Parameters<LlmService["init"]>[1];

function summarize(reports: readonly EvalRunReport[]): boolean {
  let blockingFailed = false;
  console.log("\n=== Eval summary ===");
  for (const report of reports) {
    console.log(
      `\n${report.suite} (${report.suiteVersion}): ${report.passed} passed, ${report.failed} failed`
    );
    for (const result of report.results) {
      const status = result.passed ? "PASS" : "FAIL";
      if (!result.passed && result.severity === "blocking") blockingFailed = true;
      console.log(
        `  ${status} ${result.caseId} [${result.severity}] ${result.passes}/${result.runs} runs`
      );
    }
  }
  console.log(`\nReports written to ${outputDir}`);
  return blockingFailed;
}

async function main(): Promise<void> {
  if (process.env.EVAL_LIVE !== "1" && process.env.EVAL_LIVE !== "true") {
    console.log(
      [
        "Live evals are opt-in. To run them against real providers:",
        "",
        "  Hosted:  EVAL_LIVE=1 LLM_API_KEY=<key> [EVAL_PROVIDER=openai] [EVAL_MODEL=gpt-4o-mini] pnpm evals",
        "  Ollama:  EVAL_LIVE=1 EVAL_PROVIDER=openai-compatible EVAL_BASE_URL=http://localhost:11434/v1 EVAL_MODEL=gemma3 pnpm evals",
        "",
        "They cost tokens and are nondeterministic, so they are not part of PR CI.",
      ].join("\n")
    );
    return;
  }

  const { config, provider, apiKeyEnv, baseUrl, requiresKey } = buildLlmConfig();
  if (requiresKey && !process.env[apiKeyEnv]) {
    console.error(
      `EVAL_LIVE is set but ${apiKeyEnv} is empty. Set the provider API key, or use a local ` +
        "OpenAI-compatible endpoint via EVAL_PROVIDER=openai-compatible + EVAL_BASE_URL."
    );
    process.exitCode = 1;
    return;
  }
  if (provider === "openai-compatible" && !baseUrl) {
    console.error(
      "EVAL_PROVIDER=openai-compatible requires EVAL_BASE_URL (e.g. http://localhost:11434/v1 for Ollama)."
    );
    process.exitCode = 1;
    return;
  }

  const llm = new LlmService();
  await llm.init(config, NO_SECRETS);

  const judge = new LlmJudgeModel(llm.getModel("complex"));
  const chatModel = modelTarget({ model: llmEvalModelPort(llm.getModel("standard")) });
  const loopTarget = agentLoopTarget({
    model: llmEvalModelPort(llm.getModel("standard")),
    dispatch: stubDispatch,
    tools: EVAL_TOOLS,
  });

  const runs = process.env.EVAL_RUNS ? Number(process.env.EVAL_RUNS) : undefined;
  const source = fileDatasetSource({ dir: datasetsDir });
  const sink = fileSink({ dir: outputDir });

  const suites: { suite: string; target: EvalTarget; scorers: Scorer[] }[] = [
    { suite: "quality", target: chatModel, scorers: [llmJudge({ judge })] },
    { suite: "safety", target: chatModel, scorers: [mustRefuse(), notContainsForbidden()] },
    { suite: "tool-use", target: loopTarget, scorers: [toolCalledFromExpected()] },
  ];

  const reports: EvalRunReport[] = [];
  for (const { suite, target, scorers } of suites) {
    const dataset = await source.load(suite);
    console.log(`Running ${suite} (${dataset.cases.length} cases)...`);
    reports.push(
      await runEvals({
        suite: dataset.suite,
        suiteVersion: dataset.suiteVersion,
        agentId: dataset.suite,
        cases: dataset.cases,
        target,
        scorers,
        sink,
        ...(runs === undefined ? {} : { runs }),
      })
    );
  }

  const blockingFailed = summarize(reports);
  process.exitCode = blockingFailed ? 1 : 0;
}

main().catch((error) => {
  console.error("eval run failed:", error);
  process.exitCode = 1;
});
