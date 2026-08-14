import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LlmProviderError } from "../provider-error";

/**
 * The SDK is replaced wholesale with a scripted async generator (the pattern qm uses in
 * `test/claude-harness-turn.test.ts`): no subprocess, no credential, no network — just the exact
 * message sequence a real turn produces, so the adapter's translation of it is what is under test.
 */

type ScriptMessage = Record<string, unknown>;

interface QueryCall {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}

let script: ScriptMessage[] = [];
let calls: QueryCall[] = [];
let interrupts = 0;
let scriptError: Error | undefined;
let scriptDelayMs = 0;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn((args: QueryCall) => {
    calls.push(args);
    async function* iterate() {
      for (const message of script) {
        if (scriptDelayMs) await new Promise((resolve) => setTimeout(resolve, scriptDelayMs));
        yield message;
      }
      if (scriptError) throw scriptError;
    }
    const iterator = iterate();
    return {
      [Symbol.asyncIterator]: () => iterator,
      interrupt: async () => {
        interrupts++;
      },
    };
  }),
  createSdkMcpServer: vi.fn((config: { name: string }) => ({ __server: config.name })),
  tool: vi.fn((name: string, description: string, shape: unknown, handler: unknown) => ({
    name,
    description,
    shape,
    handler,
  })),
}));

const { ClaudeCodeModel, isAuthFailure, stripMcpPrefix } = await import("./claude-code");

const lastOptions = () => calls[calls.length - 1]?.options ?? {};

function textDelta(text: string): ScriptMessage {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

function assistant(
  id: string,
  content: Array<Record<string, unknown>>,
  usage?: Record<string, number>
): ScriptMessage {
  return { type: "assistant", message: { id, content, usage } };
}

function result(overrides: Record<string, unknown> = {}): ScriptMessage {
  return { type: "result", subtype: "success", is_error: false, result: "done", ...overrides };
}

function callOptions(overrides: Partial<LanguageModelV4CallOptions> = {}) {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...overrides,
  } as LanguageModelV4CallOptions;
}

const searchTool = {
  type: "function" as const,
  name: "search_knowledge",
  description: "Search the knowledge base",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
};

const createTool = {
  type: "function" as const,
  name: "create_resource",
  description: "Create a resource",
  inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
};

beforeEach(() => {
  script = [];
  calls = [];
  interrupts = 0;
  scriptError = undefined;
  scriptDelayMs = 0;
});

describe("stripMcpPrefix", () => {
  // A1 — this is the bug that made every tool call unresolvable. Both directions are asserted:
  // the SDK's namespaced form must be stripped, and anything else must survive untouched.
  it("strips the tulipfarm MCP namespace", () => {
    expect(stripMcpPrefix("mcp__tulipfarm__search_knowledge")).toBe("search_knowledge");
  });

  it("passes an unprefixed name through unchanged", () => {
    expect(stripMcpPrefix("search_knowledge")).toBe("search_knowledge");
  });

  it("leaves another server's namespace alone rather than mangling it", () => {
    expect(stripMcpPrefix("mcp__other__search")).toBe("mcp__other__search");
  });

  it("strips only the leading occurrence", () => {
    expect(stripMcpPrefix("mcp__tulipfarm__mcp__tulipfarm__x")).toBe("mcp__tulipfarm__x");
  });
});

describe("isAuthFailure", () => {
  // These strings are observed provider wordings, not guesses. If an SDK update reworded one and
  // this table were not here, the failure would silently degrade to `model_error` and the fallback
  // chain would burn every remaining provider on what is purely a credential problem.
  it.each([
    "API Error: 400 Not a valid API key for this workspace",
    "Invalid API key · Please run /login",
    "invalid x-api-key",
    "OAuth token has expired",
    "401 Unauthorized",
    "403 Forbidden",
    "authentication_error",
    "Your credit balance is too low to access the Anthropic API",
    // Captured verbatim from the shipped container image (linux-arm64 claude 2.1.211) by sending a
    // deliberately invalid OAuth token. That turn also proves the trap the `result` handler guards:
    // the SDK reported `subtype: "success"` alongside `is_error: true` and `api_error_status: 401`.
    "Failed to authenticate. API Error: 401 OAuth access token is invalid",
  ])("classifies %j as an auth failure", (text) => {
    expect(isAuthFailure(text)).toBe(true);
  });

  it.each([
    "Error: connection reset by peer",
    "overloaded_error: server is overloaded",
    "context length exceeded",
  ])("does not classify %j as an auth failure", (text) => {
    expect(isAuthFailure(text)).toBe(false);
  });
});

describe("ClaudeCodeModel — turn translation", () => {
  it("streams text and reports usage", async () => {
    script = [
      textDelta("Hello"),
      textDelta(" world"),
      assistant("msg_1", [{ type: "text", text: "Hello world" }], {
        input_tokens: 100,
        output_tokens: 20,
      }),
      result(),
    ];
    const model = new ClaudeCodeModel("sonnet", "tok");
    const generated = await model.doGenerate(callOptions());

    expect(generated.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(generated.finishReason.unified).toBe("stop");
    expect(generated.usage.inputTokens.total).toBe(100);
    expect(generated.usage.outputTokens.total).toBe(20);
  });

  it("strips the MCP namespace off captured tool calls", async () => {
    script = [
      assistant("msg_1", [
        {
          type: "tool_use",
          id: "call_1",
          name: "mcp__tulipfarm__search_knowledge",
          input: { q: "tulips" },
        },
      ]),
    ];
    const model = new ClaudeCodeModel("sonnet", "tok");
    const generated = await model.doGenerate(callOptions({ tools: [searchTool] }));

    expect(generated.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "search_knowledge",
        input: JSON.stringify({ q: "tulips" }),
      },
    ]);
    expect(generated.finishReason.unified).toBe("tool-calls");
  });

  it("captures every parallel tool call in one assistant message before aborting", async () => {
    script = [
      assistant("msg_1", [
        { type: "text", text: "working" },
        { type: "tool_use", id: "call_1", name: "mcp__tulipfarm__search_knowledge", input: {} },
        { type: "tool_use", id: "call_2", name: "mcp__tulipfarm__create_resource", input: {} },
      ]),
      result(),
    ];
    const model = new ClaudeCodeModel("sonnet", "tok");
    const generated = await model.doGenerate(callOptions({ tools: [searchTool, createTool] }));

    const toolCalls = generated.content.filter((part) => part.type === "tool-call");
    expect(toolCalls.map((part) => (part as { toolName: string }).toolName)).toEqual([
      "search_knowledge",
      "create_resource",
    ]);
    expect(interrupts).toBe(1);
  });

  it("max-merges repeated usage per message id instead of summing it", async () => {
    // A5 — the SDK re-reports a message's cumulative usage on every emission for that id. Summing
    // inflates input tokens, and with them every budget and metric derived from them.
    script = [
      assistant("msg_1", [], { input_tokens: 100, output_tokens: 5 }),
      assistant("msg_1", [], { input_tokens: 100, output_tokens: 12 }),
      assistant("msg_1", [{ type: "text", text: "ok" }], { input_tokens: 100, output_tokens: 20 }),
      assistant("msg_2", [], { input_tokens: 40, output_tokens: 3 }),
      result(),
    ];
    const model = new ClaudeCodeModel("sonnet", "tok");
    const generated = await model.doGenerate(callOptions());

    expect(generated.usage.inputTokens.total).toBe(140);
    expect(generated.usage.outputTokens.total).toBe(23);
  });

  it("folds cache tokens into the input total", async () => {
    script = [
      assistant("msg_1", [], {
        input_tokens: 10,
        cache_read_input_tokens: 90,
        cache_creation_input_tokens: 5,
        output_tokens: 1,
      }),
      result(),
    ];
    const model = new ClaudeCodeModel("sonnet", "tok");
    const generated = await model.doGenerate(callOptions());
    expect(generated.usage.inputTokens.total).toBe(105);
  });

  it("extracts the first JSON object when the caller asked for JSON", async () => {
    script = [
      textDelta('Sure! Here you go:\n```json\n{"name": "Tulip"'),
      textDelta(', "count": 3}\n```\nHope that helps.'),
      result(),
    ];
    const model = new ClaudeCodeModel("sonnet", "tok");
    const generated = await model.doGenerate(
      callOptions({
        responseFormat: { type: "json", name: "Flower", schema: { type: "object" } },
      })
    );

    expect(generated.content).toEqual([{ type: "text", text: '{"name": "Tulip", "count": 3}' }]);
  });

  it("falls back to the raw buffer when no JSON object can be extracted", async () => {
    script = [textDelta("I cannot answer that."), result()];
    const model = new ClaudeCodeModel("sonnet", "tok");
    const generated = await model.doGenerate(
      callOptions({ responseFormat: { type: "json", name: "Flower", schema: { type: "object" } } })
    );
    expect(generated.content).toEqual([{ type: "text", text: "I cannot answer that." }]);
  });

  it("emits stream parts in order through doStream", async () => {
    script = [
      textDelta("a"),
      textDelta("b"),
      assistant("msg_1", [], { input_tokens: 7, output_tokens: 2 }),
      result(),
    ];
    const model = new ClaudeCodeModel("sonnet", "tok");
    const { stream } = await model.doStream(callOptions());
    const parts: Array<{ type: string }> = [];
    for await (const part of stream) parts.push(part);

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });
});

describe("ClaudeCodeModel — failure classification", () => {
  it("raises a hard authentication failure for a rejected credential", async () => {
    // A2 — the exact shape observed live: `subtype: "success"` with `is_error: true`. Anything
    // less specific than checking both would let this through as a successful turn.
    script = [
      result({
        is_error: true,
        result: "API Error: 400 Not a valid API key for this workspace",
      }),
    ];
    const model = new ClaudeCodeModel("sonnet", "tok");
    const promise = model.doGenerate(callOptions());

    await expect(promise).rejects.toBeInstanceOf(LlmProviderError);
    await expect(promise).rejects.toMatchObject({ reason: "model_authentication_failed" });
  });

  it("carries an actionable remediation and the provider's own wording", async () => {
    script = [result({ is_error: true, result: "Invalid API key · Please run /login" })];
    const model = new ClaudeCodeModel("sonnet", "tok");
    let error: LlmProviderError | undefined;
    try {
      await model.doGenerate(callOptions());
    } catch (err) {
      error = err as LlmProviderError;
    }
    expect((error?.cause as Error).message).toContain("claude setup-token");
    expect((error?.cause as Error).message).toContain("Please run /login");
  });

  it("raises a plain error for a non-auth failure so the fallback chain may retry", async () => {
    script = [result({ subtype: "error_during_execution", result: "overloaded_error" })];
    const model = new ClaudeCodeModel("sonnet", "tok");
    const promise = model.doGenerate(callOptions());
    await expect(promise).rejects.toThrow("overloaded_error");
    await expect(promise).rejects.not.toBeInstanceOf(LlmProviderError);
  });

  it("treats is_error on a success subtype as a failure", async () => {
    script = [result({ subtype: "success", is_error: true, result: "something broke" })];
    const model = new ClaudeCodeModel("sonnet", "tok");
    await expect(model.doGenerate(callOptions())).rejects.toThrow("something broke");
  });

  it("never leaks the OAuth token into an error message or stack", async () => {
    const token = "sk-ant-oat01-supersecret-value";
    script = [result({ is_error: true, result: "API Error: 400 Not a valid API key" })];
    const model = new ClaudeCodeModel("sonnet", token);
    let error: Error | undefined;
    try {
      await model.doGenerate(callOptions());
    } catch (err) {
      error = err as Error;
    }
    const serialized = [
      error?.message,
      error?.stack,
      (error?.cause as Error | undefined)?.message,
      (error?.cause as Error | undefined)?.stack,
    ].join(" ");
    expect(serialized).not.toContain(token);
  });

  it("never leaks the OAuth token when the SDK itself throws", async () => {
    const token = "sk-ant-oat01-supersecret-value";
    scriptError = new Error("spawn failed");
    const model = new ClaudeCodeModel("sonnet", token);
    let error: Error | undefined;
    try {
      await model.doGenerate(callOptions());
    } catch (err) {
      error = err as Error;
    }
    expect(`${error?.message} ${error?.stack}`).not.toContain(token);
  });
});

describe("ClaudeCodeModel — subprocess isolation", () => {
  it("jails HOME and withholds every unrelated host secret", async () => {
    process.env.DATABASE_URL = "postgres://should-never-reach-the-child";
    process.env.ENCRYPTION_KEY = "should-never-reach-the-child";
    process.env.OPENAI_API_KEY = "sk-should-never-reach-the-child";
    try {
      script = [result()];
      await new ClaudeCodeModel("sonnet", "tok").doGenerate(callOptions());

      const env = lastOptions().env as NodeJS.ProcessEnv;
      expect(env.HOME).toBeDefined();
      expect(env.HOME).not.toBe(process.env.HOME);
      expect(env.HOME).toBe(lastOptions().cwd);
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.ENCRYPTION_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
      expect(env.CLAUDE_CONFIG_DIR).toBe(`${env.HOME}/.claude`);
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.ENCRYPTION_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("withholds ambient Anthropic credentials that would override the subscription token", async () => {
    // These three were once on the passthrough list. `api_key_ref: env://ANTHROPIC_API_KEY` is a
    // supported way to configure the API-keyed `anthropic` provider, so any deployment running
    // both providers has it set — and the CLI changes credential selection when it sees one.
    // Verified against the vendored `claude` 0.3.211 with `env -i` and a jailed HOME: the OAuth
    // token alone authenticates as the subscription, but adding ANTHROPIC_API_KEY makes it refuse
    // with "a non-OAuth Anthropic credential cannot satisfy the org pin". On a host without that
    // pin the API key simply answers — billing the operator for a turn reported as unpriced.
    // ANTHROPIC_BASE_URL is the same class: it redirects subscription traffic to a third party.
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-reach-the-child";
    process.env.ANTHROPIC_AUTH_TOKEN = "should-never-reach-the-child";
    process.env.ANTHROPIC_BASE_URL = "https://should-never-reach-the-child.example";
    try {
      script = [result()];
      await new ClaudeCodeModel("sonnet", "tok").doGenerate(callOptions());

      const env = lastOptions().env as NodeJS.ProcessEnv;
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      // The credential the adapter was actually given still reaches the child.
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  it("ignores the host's own CLI configuration", async () => {
    script = [result()];
    await new ClaudeCodeModel("sonnet", "tok").doGenerate(callOptions());
    const options = lastOptions();

    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.persistSession).toBe(false);
    expect(options.tools).toEqual([]);
    expect(options.skills).toEqual([]);
  });

  it("grants no permission bypass — nothing declared here is ever meant to execute", async () => {
    // A7 — qm needs these because its bridged tools genuinely run. Here the turn is aborted before
    // execution can be reached, so carrying them would be pure attack surface.
    script = [result()];
    await new ClaudeCodeModel("sonnet", "tok").doGenerate(callOptions({ tools: [searchTool] }));
    const options = lastOptions();

    expect(options.permissionMode).toBeUndefined();
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it("allowlists exactly the declared tools, in the namespaced form the SDK requires", async () => {
    script = [result()];
    await new ClaudeCodeModel("sonnet", "tok").doGenerate(
      callOptions({ tools: [searchTool, createTool] })
    );

    expect(lastOptions().allowedTools).toEqual([
      "mcp__tulipfarm__search_knowledge",
      "mcp__tulipfarm__create_resource",
    ]);
  });

  it("omits the credential env var entirely when no token was supplied", async () => {
    script = [result()];
    await new ClaudeCodeModel("sonnet", undefined).doGenerate(callOptions());
    expect((lastOptions().env as NodeJS.ProcessEnv).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("fails a hung turn at the configured timeout instead of returning a partial answer", async () => {
    // A8 — the setup wizard probes with a short timeout so a bad token fails the request fast
    // instead of parking an HTTP handler for the ten-minute default.
    //
    // It must *fail*, not return early. An aborted turn ends its event stream normally, so a
    // truncated turn used to be indistinguishable from a finished one: `finishReason` read `stop`
    // and the AgentLoop committed the half-written text to the durable transcript as the final
    // answer. Every other provider surfaces a timeout as an error, and so does this one.
    script = [textDelta("a"), textDelta("b"), textDelta("c"), textDelta("d"), result()];
    scriptDelayMs = 400;

    const started = Date.now();
    await expect(new ClaudeCodeModel("haiku", "tok", 20).doGenerate(callOptions())).rejects.toThrow(
      /timed out/
    );

    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("fails a hung stream at the configured timeout", async () => {
    script = [textDelta("a"), textDelta("b"), result()];
    scriptDelayMs = 400;

    const { stream } = await new ClaudeCodeModel("haiku", "tok", 20).doStream(callOptions());
    const reader = stream.getReader();
    const read = async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    };

    await expect(read()).rejects.toThrow(/timed out/);
  });

  it("still runs to completion when the turn finishes inside the timeout", async () => {
    script = [textDelta("a"), result()];
    const generated = await new ClaudeCodeModel("haiku", "tok", 5_000).doGenerate(callOptions());
    expect(generated.content).toEqual([{ type: "text", text: "a" }]);
  });
});

describe("ClaudeCodeModel — prompt construction", () => {
  it("hands the rendered transcript to the CLI as a single user turn", async () => {
    script = [result()];
    await new ClaudeCodeModel("sonnet", "tok").doGenerate(
      callOptions({
        prompt: [
          { role: "system", content: "You are TulipFarm." },
          { role: "user", content: [{ type: "text", text: "who am I?" }] },
        ],
      })
    );

    const options = lastOptions();
    expect(options.systemPrompt).toBe("You are TulipFarm.");

    const messages: Array<{ message: { content: Array<{ type: string; text?: string }> } }> = [];
    for await (const message of calls[0].prompt as AsyncIterable<never>) messages.push(message);
    expect(messages).toHaveLength(1);
    expect(messages[0].message.content[0].text).toContain("who am I?");
    expect(messages[0].message.content[0].text).toContain("BEGIN TRANSCRIPT");
  });

  it("appends the JSON-mode instruction to the system prompt", async () => {
    script = [result()];
    await new ClaudeCodeModel("sonnet", "tok").doGenerate(
      callOptions({
        prompt: [{ role: "system", content: "Base." }],
        responseFormat: { type: "json", name: "Audit", schema: { type: "object" } },
      })
    );

    const systemPrompt = lastOptions().systemPrompt as string;
    expect(systemPrompt).toContain("Base.");
    expect(systemPrompt).toContain("single JSON object only");
    expect(systemPrompt).toContain("Audit");
  });

  it("sends a placeholder rather than an empty prompt when there is no history", async () => {
    script = [result()];
    await new ClaudeCodeModel("sonnet", "tok").doGenerate(callOptions({ prompt: [] }));

    const messages: Array<{ message: { content: Array<{ text?: string }> } }> = [];
    for await (const message of calls[0].prompt as AsyncIterable<never>) messages.push(message);
    expect(messages[0].message.content[0].text).toBe("(no prior conversation)");
  });
});
