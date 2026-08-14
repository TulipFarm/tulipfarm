import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import {
  createSdkMcpServer,
  query,
  type SDKMessage,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { fromJSONSchema, type ZodObject } from "zod";
import { LlmProviderError } from "../provider-error";
import { CliLanguageModel, type CliTurnEvent } from "./base";
import { createCliJail, jailedEnv } from "./jail";
import { firstJsonObject, jsonModeInstruction } from "./structured";
import { functionTools, type RenderedImage, renderTranscript } from "./transcript";

/**
 * `LanguageModelV4` over `@anthropic-ai/claude-agent-sdk` — lets a user with a Claude Pro/Max
 * subscription (no API key) run TulipFarm. See `docs/plans/cli-agent-providers.md` for the full
 * design; the short version: one `query()` call per AgentLoop iteration, tools are declared to
 * the SDK but never executed — the assistant message carrying `tool_use` blocks is captured and
 * the query aborted before the SDK would ever invoke them, so the real dispatch stays on
 * TulipFarm's Tool Broker. `settingSources: []` ignores the host's own `~/.claude` config
 * entirely; the credential and everything else the subprocess can see is scoped by `jail.ts`.
 */

/**
 * The credential is handed to the child explicitly (`CLAUDE_CODE_OAUTH_TOKEN` in `extraVars`), so
 * nothing Anthropic-shaped is inherited from the host.
 *
 * `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` were passed through here
 * once and must not come back. TulipFarm's own `api_key_ref: env://ANTHROPIC_API_KEY` escape hatch
 * makes that variable a *supported* way to configure the API-keyed `anthropic` provider, so any
 * deployment running both providers has it set — and the CLI changes credential selection when it
 * sees one. Verified against the vendored `claude` 0.3.211 with a jailed `HOME` and `env -i`:
 * with the OAuth token alone it authenticates as the subscription; add `ANTHROPIC_API_KEY` and it
 * refuses with "a non-OAuth Anthropic credential cannot satisfy the org pin". On a host without
 * that pin the failure is worse than loud — the API key answers, billing the operator's account
 * for a turn TulipFarm reports as unpriced. An ambient `ANTHROPIC_BASE_URL` is the same class of
 * hazard: it silently redirects subscription traffic to a third party.
 */
const CLAUDE_ENV_PASSTHROUGH = [] as const;

const MCP_SERVER_NAME = "tulipfarm";

/**
 * Tools reach the model through an in-process MCP server, and Claude Code namespaces every MCP
 * tool as `mcp__<server>__<tool>` — that is the name the model puts in its `tool_use` blocks.
 * TulipFarm's AgentLoop resolves a call against the bare names it exposed
 * (`exposed.get(call.name)`, `packages/agent-runtime/src/loop/loop.ts`), so handing the namespaced
 * form straight through refuses *every* call as `tool_not_available`. Strip the one prefix this
 * adapter is responsible for; anything else passes untouched rather than being mangled.
 */
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export function stripMcpPrefix(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

function userMessage(text: string, images: readonly RenderedImage[]): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text },
        ...images.map((image) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: image.mimeType, data: image.dataBase64 },
        })),
      ],
    },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

async function* singleTurnPrompt(
  text: string,
  images: readonly RenderedImage[]
): AsyncGenerator<SDKUserMessage> {
  yield userMessage(text, images);
}

function deltaText(message: SDKMessage): string | undefined {
  if (message.type !== "stream_event") return undefined;
  const event = message.event as { type?: string; delta?: { type?: string; text?: string } };
  if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
    return typeof event.delta.text === "string" ? event.delta.text : undefined;
  }
  return undefined;
}

/**
 * A failed turn arrives as a `result` message whose `result` string is the raw provider error —
 * there is no status code to switch on. Classifying it matters more than it looks: an
 * unclassified credential failure becomes a generic `model_error`, which `isHardFailure`
 * (`packages/llm/src/fallback.ts`) treats as transient, so one expired token walks the entire
 * fallback chain instead of stopping at the provider that actually needs re-authenticating.
 *
 * These patterns are the observed wordings, not guesses — notably Claude Code reports a rejected
 * credential as "Not a valid API key for this workspace", which no "invalid api key" match would
 * ever catch. They are frozen in `claude-code.test.ts` so an SDK rewording fails in CI.
 */
const AUTH_FAILURE_PATTERNS = [
  /not a valid api key/i,
  /invalid api key/i,
  /invalid x-api-key/i,
  /oauth/i,
  /unauthorized/i,
  /authentication/i,
  /authentication_error/i,
  /\b401\b/,
  /\b403\b/,
  /credit balance/i,
  /please run \/login/i,
  /run `claude setup-token`/i,
] as const;

export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Remediation the operator can act on, surfaced alongside the classified failure. */
const REAUTH_HINT =
  "Claude Code credential rejected — run `claude setup-token` and paste the new token in Settings.";

/** Tools are declared to the SDK so it can emit `tool_use` blocks, but never actually executed —
 * every real call is captured off the assistant message and dispatched through the Tool Broker
 * instead. This handler exists only to satisfy the SDK's `tool()` API; reaching it is a bug. */
function declareTools(tools: LanguageModelV4CallOptions["tools"]) {
  return functionTools(tools).map((definition) => {
    const schema = fromJSONSchema(
      definition.inputSchema as Parameters<typeof fromJSONSchema>[0]
    ) as ZodObject;
    return tool(definition.name, definition.description ?? "", schema.shape, async () => {
      throw new Error(
        "tulipfarm: CLI provider tool executed unexpectedly — tool calls must be captured, not run, here"
      );
    });
  });
}

export class ClaudeCodeModel extends CliLanguageModel {
  readonly provider = "claude-code";

  constructor(
    modelId: string,
    private readonly oauthToken: string | undefined,
    timeoutMs?: number
  ) {
    super(modelId, timeoutMs);
  }

  protected async *runTurn(
    options: LanguageModelV4CallOptions,
    signal: AbortSignal
  ): AsyncGenerator<CliTurnEvent> {
    const jail = createCliJail("tf-claude-");
    try {
      const { systemText, transcriptText, images } = renderTranscript(options.prompt);
      const responseFormat = options.responseFormat;
      const jsonMode = responseFormat?.type === "json";
      const systemPrompt = jsonMode
        ? systemText + jsonModeInstruction(responseFormat.schema, responseFormat.name)
        : systemText;

      const declared = declareTools(options.tools);
      const server = createSdkMcpServer({
        name: MCP_SERVER_NAME,
        version: "1",
        tools: declared,
        alwaysLoad: true,
      });
      const allowedTools = declared.map((definition) => `${MCP_TOOL_PREFIX}${definition.name}`);

      const controller = new AbortController();
      signal.addEventListener("abort", () => controller.abort(), { once: true });

      const env = jailedEnv(process.env, jail.home, CLAUDE_ENV_PASSTHROUGH, {
        CLAUDE_CONFIG_DIR: join(jail.home, ".claude"),
        ...(this.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: this.oauthToken } : {}),
      });

      const sdkQuery = query({
        prompt: singleTurnPrompt(transcriptText || "(no prior conversation)", images),
        options: {
          abortController: controller,
          cwd: jail.home,
          env,
          tools: [],
          skills: [],
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: { [MCP_SERVER_NAME]: server },
          // `allowedTools` is the whole permission story here. Nothing this adapter declares is
          // ever meant to run — the assistant message carrying `tool_use` is captured and the
          // query aborted before the SDK reaches execution — so the `bypassPermissions` /
          // `allowDangerouslySkipPermissions` pair qm needs (its bridged tools genuinely execute)
          // would be pure attack surface. An explicit allowlist also means a stray call to
          // anything else cannot silently park the subprocess on an interactive prompt.
          allowedTools,
          persistSession: false,
          includePartialMessages: true,
          systemPrompt: systemPrompt || undefined,
          model: this.modelId,
        },
      });

      /**
       * The SDK re-reports a message's cumulative usage on every `assistant` message it emits for
       * that message id, so summing naively inflates input tokens — and with them every budget and
       * metric derived from them. Keep the highest figure seen per id and sum the ids at the end
       * (ported from `qm/src/harness/claude-harness.ts`).
       */
      const usageById = new Map<string, { input: number; output: number }>();
      let buffered = "";
      let sawToolCall = false;

      for await (const message of sdkQuery) {
        if (signal.aborted) break;

        const delta = deltaText(message);
        if (delta !== undefined) {
          if (jsonMode) buffered += delta;
          else yield { type: "text-delta", delta };
          continue;
        }

        if (message.type === "assistant") {
          const usage = message.message.usage as
            | {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              }
            | undefined;
          if (usage) {
            const id = message.message.id ?? "unknown";
            const seen = {
              input:
                (usage.input_tokens ?? 0) +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0),
              output: usage.output_tokens ?? 0,
            };
            const known = usageById.get(id);
            usageById.set(
              id,
              known
                ? {
                    input: Math.max(known.input, seen.input),
                    output: Math.max(known.output, seen.output),
                  }
                : seen
            );
          }
          const content = message.message.content as Array<{
            type: string;
            id?: string;
            name?: string;
            input?: unknown;
          }>;
          for (const block of content) {
            if (block.type === "tool_use" && block.id && block.name) {
              sawToolCall = true;
              yield {
                type: "tool-call",
                toolCallId: block.id,
                toolName: stripMcpPrefix(block.name),
                input: block.input,
              };
            }
          }
          if (sawToolCall) {
            await sdkQuery.interrupt().catch(() => undefined);
            controller.abort();
            break;
          }
          continue;
        }

        if (message.type === "result") {
          const result = message as unknown as {
            subtype?: string;
            result?: string;
            is_error?: boolean;
          };
          // A rejected credential still reports `subtype: "success"` — only `is_error` and the
          // `result` text distinguish it from a real completion, so both must be checked.
          if (result.subtype !== "success" || result.is_error) {
            const text = result.result ?? result.subtype ?? "Claude Code turn failed";
            if (isAuthFailure(text)) {
              // `LlmProviderError` keeps only its reason participant-visible; the cause is
              // operator-only, and `AgentLoop`'s `deepestErrorMessage` surfaces it in the log —
              // so it carries both the remediation and the provider's own wording.
              throw new LlmProviderError(
                "model_authentication_failed",
                new Error(`${REAUTH_HINT} (provider said: ${text})`)
              );
            }
            throw new Error(text);
          }
        }
      }

      if (jsonMode && buffered) {
        yield { type: "text-delta", delta: firstJsonObject(buffered) ?? buffered };
      }

      let inputTokens = 0;
      let outputTokens = 0;
      for (const seen of usageById.values()) {
        inputTokens += seen.input;
        outputTokens += seen.output;
      }
      yield { type: "usage", inputTokens, outputTokens };
    } finally {
      jail.cleanup();
    }
  }
}
