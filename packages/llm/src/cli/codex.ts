import { createRequire } from "node:module";
import { join } from "node:path";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4ToolResultOutput,
} from "@ai-sdk/provider";
import { LlmProviderError } from "../provider-error";
import { CliLanguageModel, type CliTurnEvent } from "./base";
import { readRotatedCodexAuth, writeCodexHome } from "./codex-auth";
import { CodexRpc, CodexRpcError } from "./codex-rpc";
import { createCliJail, jailedEnv } from "./jail";
import { firstJsonObject, jsonModeInstruction } from "./structured";
import { functionTools } from "./transcript";

/** Codex model adapter: captures Tool calls for TulipFarm and replays history structurally. */

const CODEX_ENV_PASSTHROUGH = ["OPENAI_BASE_URL"] as const;

/** Codex looks up `$CODEX_HOME/auth.json`; everything else it reads is scoped by the jail. */
const REAUTH_HINT =
  "Codex credential rejected — run `codex login`, then paste the new ~/.codex/auth.json in Settings.";

/** Setup must fail fast; the long turn timeout is for model thinking, not dead subprocesses. */
const SETUP_TIMEOUT_MS = 30_000;

/** Max wait for `turn/interrupt` before child teardown. */
const INTERRUPT_TIMEOUT_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/** Codex 0.147.0 hides auth failures in structured status; fail on first 401/402/403. */
const AUTH_STATUS_CODES = new Set([401, 402, 403]);

const CODEX_AUTH_FAILURE_PATTERN =
  /\b(?:401|402|403)\b|unauthoriz|forbidden|invalid[_ -]?api[_ -]?key|incorrect api key|authentication (?:error|failed)|missing bearer|missing (?:api key|credentials)|not logged in|codex login|insufficient[_ -]?quota|exceeded your current quota|billing|credit(?: balance| limit)|out of credits|credits_depleted|must be verified/i;

export function isCodexAuthFailure(text: string): boolean {
  return CODEX_AUTH_FAILURE_PATTERN.test(text);
}

/** The HTTP status Codex buried in a structured error payload, when it carries one. */
export function codexErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const info = (error as { codexErrorInfo?: unknown }).codexErrorInfo;
  if (!info || typeof info !== "object") return undefined;
  const disconnected = (info as { responseStreamDisconnected?: unknown })
    .responseStreamDisconnected;
  if (!disconnected || typeof disconnected !== "object") return undefined;
  const status = (disconnected as { httpStatusCode?: unknown }).httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

/** Detect credential errors from status code before prose. */
export function isCodexAuthError(error: unknown): boolean {
  const status = codexErrorStatus(error);
  if (status !== undefined) return AUTH_STATUS_CODES.has(status);
  if (!error || typeof error !== "object") return false;
  const record = error as { message?: unknown; additionalDetails?: unknown };
  const text = [record.message, record.additionalDetails]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return text.length > 0 && isCodexAuthFailure(text);
}

/** Resolve Codex's launcher shim so upstream platform-package mapping stays authoritative. */
export function resolveCodexScript(): string {
  const override = process.env.TF_CODEX_BIN;
  if (override) return override;

  // Avoid `import.meta.url`: this file is bundled into CommonJS consumers.
  const anchors = [process.argv[1], join(process.cwd(), "noop.js")].filter(
    (a): a is string => typeof a === "string" && a.length > 0
  );
  const failures: string[] = [];
  for (const anchor of anchors) {
    try {
      const manifest = createRequire(anchor).resolve("@openai/codex/package.json");
      return manifest.replace(/package\.json$/, "bin/codex.js");
    } catch (err) {
      failures.push(`${anchor}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
  }
  throw new Error(
    `Codex provider is selected but @openai/codex could not be resolved. Tried ${failures.join("; ")}`
  );
}

interface CodexItem {
  type: string;
  [key: string]: unknown;
}

function toolResultText(output: LanguageModelV4ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "content":
      return output.value
        .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
        .join("\n");
    default:
      return "";
  }
}

export interface CodexPrompt {
  readonly instructions: string;
  readonly replay: CodexItem[];
  readonly input: string;
  /** Data URLs for the trailing turn only, sent as `image` items on `turn/start`. */
  readonly images: string[];
}

/** Splits system, replay, and turn input; tool-result turns continue without fake user text. */
export function buildCodexPrompt(prompt: LanguageModelV4Prompt): CodexPrompt {
  const instructions: string[] = [];
  const items: CodexItem[] = [];

  for (const message of prompt) {
    if (message.role === "system") {
      instructions.push(message.content);
      continue;
    }

    if (message.role === "user") {
      const content: Array<Record<string, unknown>> = [];
      for (const part of message.content) {
        if (part.type === "text") {
          content.push({ type: "input_text", text: part.text });
        } else if (
          part.type === "file" &&
          part.mediaType.startsWith("image/") &&
          part.data.type === "data"
        ) {
          const data =
            typeof part.data.data === "string"
              ? part.data.data
              : Buffer.from(part.data.data).toString("base64");
          content.push({
            type: "input_image",
            image_url: `data:${part.mediaType};base64,${data}`,
          });
        } else if (part.type === "file") {
          content.push({ type: "input_text", text: `[file: ${part.filename ?? part.mediaType}]` });
        }
      }
      if (content.length) items.push({ type: "message", role: "user", content });
      continue;
    }

    if (message.role === "assistant") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      if (text.trim()) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const part of message.content) {
        if (part.type === "tool-call") {
          items.push({
            type: "function_call",
            call_id: part.toolCallId,
            name: part.toolName,
            arguments: JSON.stringify(part.input),
          });
        } else if (part.type === "tool-result") {
          items.push({
            type: "function_call_output",
            call_id: part.toolCallId,
            output: toolResultText(part.output),
          });
        }
      }
      continue;
    }

    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          items.push({
            type: "function_call_output",
            call_id: part.toolCallId,
            output: toolResultText(part.output),
          });
        }
      }
    }
  }

  // The trailing user message is the turn's actual input; everything before it is history.
  const last = items.at(-1);
  if (last?.type === "message" && last.role === "user") {
    items.pop();
    const content = (last.content ?? []) as Array<{ text?: string; image_url?: string }>;
    return {
      instructions: instructions.join("\n\n"),
      replay: items,
      input: content
        .map((part) => part.text ?? "")
        .join("\n")
        .trim(),
      // Only the trailing turn's images ride on `turn/start`; earlier ones stay as `input_image`
      // parts inside the replayed history items, where Codex already accepts them.
      images: content.flatMap((part) => (part.image_url ? [part.image_url] : [])),
    };
  }

  return {
    instructions: instructions.join("\n\n"),
    replay: items,
    input: items.length
      ? "Continue the conversation above, taking the tool results into account."
      : "(no prior conversation)",
    images: [],
  };
}

/** Disable Codex agent features; containment relies on read-only/no-network sandbox and `never`. */
const DISABLED_FEATURES = {
  shell_tool: false,
  unified_exec: false,
  shell_snapshot: false,
  apps: false,
  plugins: false,
  browser_use: false,
  browser_use_external: false,
  computer_use: false,
  image_generation: false,
  in_app_browser: false,
  multi_agent: false,
  request_permissions_tool: false,
  tool_suggest: false,
} as const;

interface UsageTotals {
  input: number;
  output: number;
  cachedInput: number;
}

/** Codex reports usage as a running **total** for the thread, so it is replaced, never summed. */
function readUsageTotals(params: unknown): UsageTotals | undefined {
  if (!params || typeof params !== "object") return undefined;
  const usage = (params as { tokenUsage?: unknown }).tokenUsage;
  if (!usage || typeof usage !== "object") return undefined;
  const total = (usage as { total?: unknown }).total;
  if (!total || typeof total !== "object") return undefined;
  const record = total as Record<string, unknown>;
  const num = (...names: string[]): number => {
    for (const name of names) {
      const value = Number(record[name]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return 0;
  };
  // Codex `inputTokens` includes cached reads; `cachedInputTokens` is a breakdown, not an addend.
  return {
    input: num("inputTokens", "input_tokens"),
    output: num("outputTokens", "output_tokens"),
    cachedInput: num("cachedInputTokens", "cached_input_tokens"),
  };
}

export class CodexModel extends CliLanguageModel {
  readonly provider = "codex";

  constructor(
    modelId: string,
    private readonly authJson: string | undefined,
    timeoutMs?: number,
    /** Persists a credential Codex rotated mid-turn. Absent in tests and on read-only paths. */
    private readonly persistAuth?: (authJson: string) => Promise<void>,
    private readonly log?: { warn(msg: string): void }
  ) {
    super(modelId, timeoutMs);
  }

  protected async *runTurn(
    options: LanguageModelV4CallOptions,
    signal: AbortSignal
  ): AsyncGenerator<CliTurnEvent> {
    if (!this.authJson) {
      throw new LlmProviderError(
        "model_authentication_failed",
        new Error(`Codex has no stored credential. ${REAUTH_HINT}`)
      );
    }

    // Resolve before jail creation so missing Codex cannot leak per-model temp dirs.
    const scriptPath = resolveCodexScript();

    const jail = createCliJail("tf-codex-");
    let codexHome: string;
    let prompt: CodexPrompt;
    try {
      codexHome = writeCodexHome(jail.home, this.authJson);
      prompt = buildCodexPrompt(options.prompt);
    } catch (error) {
      jail.cleanup();
      throw error;
    }

    const responseFormat = options.responseFormat;
    const jsonMode = responseFormat?.type === "json";
    const { instructions, replay, input, images } = prompt;
    const baseInstructions = jsonMode
      ? instructions + jsonModeInstruction(responseFormat.schema, responseFormat.name)
      : instructions;

    const tools = functionTools(options.tools);
    // Unnamespaced by construction — Codex takes these at the top level rather than through an MCP
    // server, so the name the model calls is the name TulipFarm's AgentLoop exposed.
    const dynamicTools = tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }));

    type Emitted =
      | { kind: "text"; text: string }
      | { kind: "tool"; callId: string; name: string; input: unknown }
      | { kind: "done"; error?: string; authFailure?: boolean };

    const queue: Emitted[] = [];
    let wake: (() => void) | undefined;
    const push = (event: Emitted) => {
      queue.push(event);
      wake?.();
      wake = undefined;
    };

    let usage: UsageTotals = { input: 0, output: 0, cachedInput: 0 };
    let threadId = "";
    let turnId = "";
    let settled = false;
    const finish = (event: Emitted) => {
      if (settled) return;
      settled = true;
      push(event);
    };

    const rpc = new CodexRpc({
      scriptPath,
      cwd: jail.home,
      env: jailedEnv(process.env, jail.home, CODEX_ENV_PASSTHROUGH, { CODEX_HOME: codexHome }),
      onNotification: (method, params) => {
        const payload = (params ?? {}) as Record<string, unknown>;
        if (method === "item/agentMessage/delta" && typeof payload.delta === "string") {
          push({ kind: "text", text: payload.delta });
          return;
        }
        if (method === "thread/tokenUsage/updated") {
          usage = readUsageTotals(payload) ?? usage;
          return;
        }
        if (method === "error") {
          // Fail fast on a credential problem rather than sitting through five retries; anything
          // else the CLI says it will retry is left to it.
          if (isCodexAuthError(payload.error)) {
            finish({ kind: "done", error: describeError(payload.error), authFailure: true });
            return;
          }
          if (payload.willRetry !== true) {
            finish({ kind: "done", error: describeError(payload.error) });
          }
          return;
        }
        if (method === "turn/completed") {
          const turn = payload.turn as
            | { status?: string; error?: { message?: string } }
            | undefined;
          if (turn?.status === "failed") {
            const message = turn.error?.message ?? "codex turn failed";
            finish({ kind: "done", error: message, authFailure: isCodexAuthFailure(message) });
            return;
          }
          finish({ kind: "done" });
        }
      },
      onClose: (error) => {
        // A crash emits no `turn/completed`; finish so drain does not wait to deadline.
        finish({
          kind: "done",
          error: error.message,
          authFailure: isCodexAuthFailure(error.message),
        });
      },
      onRequest: async (method, params) => {
        if (method !== "item/tool/call") throw new Error(`unsupported codex request ${method}`);
        const payload = (params ?? {}) as Record<string, unknown>;
        const name = String(payload.tool ?? "");
        const callId = String(payload.callId ?? "");
        push({ kind: "tool", callId, name, input: payload.arguments ?? {} });
        // The dispatch itself is the Tool Broker's, not ours — this reply only unblocks the server.
        return {
          contentItems: [{ type: "inputText", text: "Handed off to TulipFarm's tool broker." }],
          success: true,
        };
      },
      onRequestReplied: () => {
        // Interrupt after the tool reply is on the wire; wait briefly before teardown.
        if (!turnId) {
          finish({ kind: "done" });
          return;
        }
        const acknowledged = rpc.request("turn/interrupt", { threadId, turnId }).then(
          () => undefined,
          () => undefined
        );
        void Promise.race([acknowledged, sleep(INTERRUPT_TIMEOUT_MS)]).then(() =>
          finish({ kind: "done" })
        );
      },
    });

    const onAbort = () => finish({ kind: "done" });
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await withDeadline(rpc.initialize(), SETUP_TIMEOUT_MS, "codex app-server handshake");

      const started = await withDeadline(
        rpc.request<{ thread: { id: string } }>("thread/start", {
          model: this.modelId,
          cwd: jail.home,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          ...(baseInstructions ? { baseInstructions } : {}),
          dynamicTools,
          environments: [],
          config: {
            web_search: "disabled",
            include_apps_instructions: false,
            include_environment_context: false,
            features: DISABLED_FEATURES,
          },
        }),
        SETUP_TIMEOUT_MS,
        "codex thread/start"
      );
      threadId = started.thread.id;

      if (replay.length) {
        await withDeadline(
          rpc.request("thread/inject_items", { threadId, items: replay }),
          SETUP_TIMEOUT_MS,
          "codex thread/inject_items"
        );
      }

      const turn = await rpc
        .request<{ turn: { id: string } }>("turn/start", {
          threadId,
          input: [
            { type: "text", text: input, text_elements: [] },
            ...images.map((url) => ({ type: "image", url })),
          ],
        })
        .catch((error: unknown) => {
          throw error instanceof CodexRpcError ? classify(error.message) : error;
        });
      turnId = turn.turn.id;

      let buffered = "";

      // Drain what the notification handlers queued, in order, until the turn settles.
      for (;;) {
        if (queue.length === 0) {
          if (signal.aborted) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        const event = queue.shift();
        if (!event) continue;

        if (event.kind === "text") {
          if (jsonMode) buffered += event.text;
          else yield { type: "text-delta", delta: event.text };
          continue;
        }
        if (event.kind === "tool") {
          yield {
            type: "tool-call",
            toolCallId: event.callId,
            toolName: event.name,
            input: event.input,
          };
          continue;
        }
        if (event.error) {
          if (event.authFailure) {
            throw new LlmProviderError(
              "model_authentication_failed",
              new Error(`${REAUTH_HINT} (provider said: ${event.error})`)
            );
          }
          throw new Error(event.error);
        }
        break;
      }

      if (jsonMode && buffered) {
        yield { type: "text-delta", delta: firstJsonObject(buffered) ?? buffered };
      }
      yield {
        type: "usage",
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cachedInput,
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      await rpc.close().catch(() => undefined);
      await this.saveRotatedAuth(codexHome);
      jail.cleanup();
    }
  }

  /** Persist a credential Codex rotated during the turn, before the jail holding it is deleted. */
  private async saveRotatedAuth(codexHome: string): Promise<void> {
    if (!this.persistAuth || !this.authJson) return;
    const rotated = readRotatedCodexAuth(codexHome, this.authJson);
    if (!rotated) return;
    try {
      await this.persistAuth(rotated);
    } catch {
      // A refresh that could not be stored is not a failed turn — the turn already succeeded, and
      // the old credential still works until its refresh token is rotated out. Never rethrow with
      // the blob in the message.
      (this.log ?? console).warn("[codex] could not persist rotated credential");
    }
  }
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return "codex turn failed";
  const record = error as { message?: unknown; additionalDetails?: unknown };
  const parts = [record.message, record.additionalDetails].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  return parts.join(" — ") || "codex turn failed";
}

function classify(message: string): Error {
  return isCodexAuthFailure(message)
    ? new LlmProviderError(
        "model_authentication_failed",
        new Error(`${REAUTH_HINT} (provider said: ${message})`)
      )
    : new Error(message);
}

/** Bound a setup step so a dead subprocess fails in seconds rather than on the turn's budget. */
async function withDeadline<T>(operation: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
