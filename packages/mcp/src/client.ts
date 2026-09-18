import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError as SdkError,
} from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "./errors";
import { type BoundTransport, createTransport } from "./transports";
import type {
  McpClientOptions,
  McpDiscovery,
  McpIdentity,
  McpLimits,
  McpOperation,
  McpPromptHandle,
  McpPromptResult,
  McpRequestOptions,
  McpResourceContent,
  McpResourceHandle,
  McpResourceTemplateHandle,
  McpServerInfo,
  McpToolHandle,
  McpToolResult,
} from "./types";

export const DEFAULT_MCP_LIMITS: Readonly<McpLimits> = Object.freeze({
  requestTimeoutMs: 30_000,
  discoveryTimeoutMs: 60_000,
  maxPages: 20,
  maxItems: 500,
  maxResponseBytes: 4 * 1024 * 1024,
});

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

export class McpClient {
  readonly identity: Readonly<McpIdentity>;
  private readonly options: McpClientOptions;
  private readonly limits: McpLimits;
  private readonly sdk = new Client({ name: "tulipfarm", version: "1.0.0" }, { capabilities: {} });
  private readonly lifetime = new AbortController();
  private readonly handles = new WeakSet<object>();
  private transport?: BoundTransport;
  private info?: McpServerInfo;
  private state: "new" | "connecting" | "connected" | "closed" = "new";

  constructor(options: McpClientOptions) {
    this.identity = freeze(structuredClone(options.identity));
    this.options = {
      ...options,
      identity: this.identity,
      server: freeze(structuredClone(options.server)),
    };
    this.limits = { ...DEFAULT_MCP_LIMITS, ...options.limits };
    for (const key of Object.keys(DEFAULT_MCP_LIMITS) as (keyof McpLimits)[]) {
      const value = this.limits[key];
      if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_MCP_LIMITS[key]) {
        throw new McpError("invalid_configuration");
      }
    }
    if (
      this.identity.serverId !== options.server.id ||
      !this.identity.subjectId ||
      !this.identity.configurationRevision ||
      typeof options.beforeRequest !== "function"
    ) {
      throw new McpError("invalid_configuration");
    }
  }

  private async admitted<T>(
    operation: McpOperation,
    request: McpRequestOptions,
    action: (signal: AbortSignal) => Promise<T>,
    timeout = this.limits.requestTimeoutMs
  ): Promise<T> {
    const timer = AbortSignal.timeout(timeout);
    const signal = AbortSignal.any([
      this.lifetime.signal,
      timer,
      ...(request.signal ? [request.signal] : []),
    ]);
    const effect = operation.type === "callTool" ? "unknown" : "none";
    let dispatched = false;
    let abortListener: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const work = (async () => {
        try {
          await this.options.beforeRequest(this.identity, operation);
        } catch {
          throw new McpError("access_denied");
        }
        signal.throwIfAborted();
        dispatched = true;
        return action(signal);
      })();
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () =>
          reject(
            new McpError(timer.aborted ? "timeout" : "cancelled", dispatched ? effect : "none")
          );
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) abortListener();
      });
      return await Promise.race([work, aborted]);
    } catch (error) {
      if (
        error instanceof SdkError &&
        error.code === ErrorCode.ConnectionClosed &&
        this.transport?.failure
      ) {
        throw new McpError(
          this.transport.failure.code,
          dispatched ? effect : "none",
          this.transport.failure
        );
      }
      if (error instanceof McpError) {
        if (
          dispatched &&
          effect === "unknown" &&
          error.effect === "none" &&
          ![
            "access_denied",
            "authentication_required",
            "unsupported_capability",
            "identity_mismatch",
          ].includes(error.code)
        ) {
          throw new McpError(error.code, "unknown", error);
        }
        throw error;
      }
      if (signal.aborted)
        throw new McpError(timer.aborted ? "timeout" : "cancelled", dispatched ? effect : "none");
      if (error instanceof SdkError) {
        throw new McpError(
          error.code === ErrorCode.RequestTimeout ? "timeout" : "protocol_failure",
          dispatched ? effect : "none",
          { protocolCode: error.code }
        );
      }
      throw new McpError("transport_failure", dispatched ? effect : "none");
    } finally {
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
  }

  async connect(request: McpRequestOptions = {}): Promise<McpServerInfo> {
    if (this.state !== "new")
      throw new McpError(this.state === "closed" ? "closed" : "invalid_configuration");
    this.state = "connecting";
    try {
      return await this.admitted({ type: "connect" }, request, async (signal) => {
        this.transport = createTransport(this.options, this.limits, this.lifetime.signal);
        try {
          await this.sdk.connect(this.transport, this.requestOptions(signal));
        } catch (error) {
          throw this.transport.failure ?? error;
        }
        const version = this.sdk.getServerVersion();
        const capabilities = this.sdk.getServerCapabilities();
        if (!version || !this.transport.protocolVersion) throw new McpError("unsupported_protocol");
        this.info = freeze({
          protocolVersion: this.transport.protocolVersion,
          name: version.name,
          version: version.version,
          capabilities: {
            tools: Boolean(capabilities?.tools),
            resources: Boolean(capabilities?.resources),
            prompts: Boolean(capabilities?.prompts),
          },
        });
        this.state = "connected";
        return this.info;
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private requestOptions(signal: AbortSignal) {
    return {
      signal,
      timeout: this.limits.requestTimeoutMs,
      maxTotalTimeout: this.limits.requestTimeoutMs,
    };
  }

  private connected(capability?: "tools" | "resources" | "prompts"): void {
    if (this.state !== "connected")
      throw new McpError(this.state === "closed" ? "closed" : "not_connected");
    if (capability && !this.info?.capabilities[capability])
      throw new McpError("unsupported_capability");
  }

  private handle<T extends object>(value: T): T & { readonly identity: Readonly<McpIdentity> } {
    const handle = freeze({ ...structuredClone(value), identity: this.identity });
    this.handles.add(handle);
    return handle;
  }

  private assertHandle(handle: { readonly kind: string }, kind: string): void {
    if (!this.handles.has(handle) || handle.kind !== kind) throw new McpError("identity_mismatch");
  }

  async discover(request: McpRequestOptions = {}): Promise<McpDiscovery> {
    this.connected();
    return this.admitted(
      { type: "discover" },
      request,
      async (signal) => {
        let pages = 0;
        let total = 0;
        let bytes = 0;
        const collect = async <T>(
          fetch: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>
        ): Promise<T[]> => {
          const items: T[] = [];
          const seen = new Set<string>();
          let cursor: string | undefined;
          do {
            signal.throwIfAborted();
            if (++pages > this.limits.maxPages) throw new McpError("discovery_limit");
            // Every page is a new disclosure; a grant can be revoked during a scan.
            try {
              await this.options.beforeRequest(this.identity, { type: "discover" });
            } catch {
              throw new McpError("access_denied");
            }
            const page = await fetch(cursor);
            total += page.items.length;
            bytes += Buffer.byteLength(JSON.stringify(page));
            if (total > this.limits.maxItems || bytes > this.limits.maxResponseBytes)
              throw new McpError("discovery_limit");
            items.push(...page.items);
            cursor = page.nextCursor;
            if (cursor !== undefined) {
              if (!cursor || seen.has(cursor)) throw new McpError("invalid_response");
              seen.add(cursor);
            }
          } while (cursor !== undefined);
          return items;
        };
        const options = this.requestOptions(signal);
        const tools = this.info?.capabilities.tools
          ? await collect(async (cursor) => {
              const page = await this.sdk.listTools(cursor ? { cursor } : {}, options);
              return { items: page.tools, nextCursor: page.nextCursor };
            })
          : [];
        const resources = this.info?.capabilities.resources
          ? await collect(async (cursor) => {
              const page = await this.sdk.listResources(cursor ? { cursor } : {}, options);
              return { items: page.resources, nextCursor: page.nextCursor };
            })
          : [];
        const resourceTemplates = this.info?.capabilities.resources
          ? await collect(async (cursor) => {
              const page = await this.sdk.listResourceTemplates(cursor ? { cursor } : {}, options);
              return { items: page.resourceTemplates, nextCursor: page.nextCursor };
            })
          : [];
        const prompts = this.info?.capabilities.prompts
          ? await collect(async (cursor) => {
              const page = await this.sdk.listPrompts(cursor ? { cursor } : {}, options);
              return { items: page.prompts, nextCursor: page.nextCursor };
            })
          : [];
        return freeze({
          tools: tools.map((tool) => this.handle({ ...tool, kind: "tool" as const })),
          resources: resources.map((resource) =>
            this.handle({ ...resource, kind: "resource" as const })
          ),
          resourceTemplates: resourceTemplates.map((template) =>
            this.handle({ ...template, kind: "resourceTemplate" as const })
          ),
          prompts: prompts.map((prompt) => this.handle({ ...prompt, kind: "prompt" as const })),
        });
      },
      this.limits.discoveryTimeoutMs
    );
  }

  resource(uri: string, template?: McpResourceTemplateHandle): McpResourceHandle {
    this.connected("resources");
    if (template) this.assertHandle(template, "resourceTemplate");
    if (!uri || uri.length > 8192) throw new McpError("invalid_configuration");
    return this.handle({ kind: "resource" as const, uri, name: template?.name ?? uri });
  }

  async callTool(
    handle: McpToolHandle,
    args: Readonly<Record<string, unknown>>,
    request: McpRequestOptions = {}
  ): Promise<McpToolResult> {
    this.connected("tools");
    this.assertHandle(handle, "tool");
    if (handle.execution?.taskSupport === "required") throw new McpError("unsupported_capability");
    const arguments_ = freeze(structuredClone(args));
    return this.admitted(
      { type: "callTool", name: handle.name, arguments: arguments_ },
      request,
      async (signal) => {
        const result = CallToolResultSchema.parse(
          await this.sdk.callTool(
            { name: handle.name, arguments: arguments_ },
            CallToolResultSchema,
            this.requestOptions(signal)
          )
        );
        return {
          content: result.content,
          ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
          ...(result.isError !== undefined ? { isError: result.isError } : {}),
        };
      }
    );
  }

  async readResource(
    handle: McpResourceHandle,
    request: McpRequestOptions = {}
  ): Promise<{ readonly contents: readonly McpResourceContent[] }> {
    this.connected("resources");
    this.assertHandle(handle, "resource");
    return this.admitted({ type: "readResource", uri: handle.uri }, request, async (signal) => {
      const result = await this.sdk.readResource({ uri: handle.uri }, this.requestOptions(signal));
      return { contents: result.contents };
    });
  }

  async getPrompt(
    handle: McpPromptHandle,
    args: Readonly<Record<string, string>> = {},
    request: McpRequestOptions = {}
  ): Promise<McpPromptResult> {
    this.connected("prompts");
    this.assertHandle(handle, "prompt");
    const arguments_ = freeze(structuredClone(args));
    return this.admitted(
      { type: "getPrompt", name: handle.name, arguments: arguments_ },
      request,
      (signal) =>
        this.sdk.getPrompt(
          { name: handle.name, arguments: arguments_ },
          this.requestOptions(signal)
        )
    );
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    this.lifetime.abort();
    await this.sdk.close();
  }
}

export function createMcpClient(options: McpClientOptions): McpClient {
  return new McpClient(options);
}
