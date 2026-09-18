import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { assertProductionSandbox } from "@tulipfarm/sandbox";
import { MCP_SUPPORTED_PROTOCOL_VERSIONS } from "@tulipfarm/schema";
import { McpError } from "./errors";
import type { McpClientOptions, McpLimits, McpStdioProcess } from "./types";

export class BoundTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  protocolVersion?: string;
  failure?: McpError;

  constructor(
    private readonly inner: Transport,
    private readonly maxBytes: number
  ) {}

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => {
      this.failure = error instanceof McpError ? error : new McpError("transport_failure");
      this.onerror?.(this.failure);
    };
    this.inner.onmessage = (message) => {
      if ("result" in message && typeof message.result.protocolVersion === "string") {
        if (
          !MCP_SUPPORTED_PROTOCOL_VERSIONS.some(
            (version) => version === message.result.protocolVersion
          )
        ) {
          this.failure = new McpError("unsupported_protocol");
        }
      }
      if (Buffer.byteLength(JSON.stringify(message)) > this.maxBytes) {
        this.failure = new McpError("response_limit");
        this.onerror?.(this.failure);
        void this.close().catch(() => this.onerror?.(new McpError("transport_failure")));
        return;
      }
      this.onmessage?.(message);
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(message)) > this.maxBytes) {
      throw new McpError("response_limit");
    }
    await this.inner.send(message);
  }

  setProtocolVersion(version: string): void {
    if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.some((supported) => supported === version)) {
      throw new McpError("unsupported_protocol");
    }
    this.protocolVersion = version;
    this.inner.setProtocolVersion?.(version);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

class IsolatedStdioTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  private process?: McpStdioProcess;
  private closed = false;

  constructor(
    private readonly open: () => Promise<McpStdioProcess>,
    private readonly maxBytes: number
  ) {}

  async start(): Promise<void> {
    this.process = await this.open();
    if (this.closed) {
      await this.process.close();
      throw new McpError("closed");
    }
    void this.read(this.process);
  }

  private async read(process: McpStdioProcess): Promise<void> {
    let pending = Buffer.alloc(0);
    try {
      for await (const bytes of process.stdout) {
        pending = Buffer.concat([pending, bytes]);
        let newline = pending.indexOf(10);
        while (newline !== -1) {
          if (newline > this.maxBytes) throw new McpError("response_limit");
          const line = pending.subarray(0, newline).toString("utf8");
          pending = pending.subarray(newline + 1);
          const parsed = JSONRPCMessageSchema.safeParse(JSON.parse(line));
          if (!parsed.success) throw new McpError("invalid_response");
          this.onmessage?.(parsed.data);
          newline = pending.indexOf(10);
        }
        if (pending.length > this.maxBytes) throw new McpError("response_limit");
      }
      if (pending.length > 0) throw new McpError("invalid_response");
    } catch (error) {
      if (!this.closed) {
        this.onerror?.(error instanceof McpError ? error : new McpError("transport_failure"));
      }
    } finally {
      try {
        await this.close();
      } catch {
        this.onerror?.(new McpError("transport_failure"));
      }
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.process || this.closed) throw new McpError("closed");
    await this.process.write(Buffer.from(`${JSON.stringify(message)}\n`));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.process?.close();
    this.onclose?.();
  }
}

export function createTransport(
  options: McpClientOptions,
  limits: McpLimits,
  signal: AbortSignal
): BoundTransport {
  if (options.server.transport.type === "stdio") {
    const backend = options.local;
    if (!backend) throw new McpError("unsupported_backend");
    const attestation = backend.attestation();
    const developmentContainer =
      options.environment === "development" &&
      attestation.isolation === "container" &&
      attestation.developmentOnly;
    if (!developmentContainer) {
      if (attestation.isolation !== "microvm" && attestation.isolation !== "remote-managed") {
        throw new McpError("unsupported_backend");
      }
      try {
        assertProductionSandbox(attestation);
      } catch {
        throw new McpError("unsupported_backend");
      }
    }
    const transport = options.server.transport;
    return new BoundTransport(
      new IsolatedStdioTransport(async () => {
        const environment = Object.freeze({
          ...(await options.localCredentials?.environment(options.identity, signal)),
        });
        const entries = Object.entries(environment);
        if (
          entries.length > 128 ||
          entries.some(
            ([key, value]) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)
          ) ||
          Buffer.byteLength(JSON.stringify(environment)) > 256 * 1024
        ) {
          throw new McpError("invalid_configuration");
        }
        signal.throwIfAborted();
        return backend.open({
          identity: options.identity,
          transport,
          signal,
          maxResponseBytes: limits.maxResponseBytes,
          environment,
        });
      }, limits.maxResponseBytes),
      limits.maxResponseBytes
    );
  }
  const remote = options.remote;
  if (!remote) throw new McpError("invalid_configuration");
  const endpoint = new URL(options.server.transport.url);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
    throw new McpError("invalid_configuration");
  }
  return new BoundTransport(
    new StreamableHTTPClientTransport(endpoint, {
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (url, init) => {
        if (new URL(url).href !== endpoint.href) throw new McpError("access_denied");
        const requestSignal = AbortSignal.any([
          signal,
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(limits.requestTimeoutMs),
        ]);
        const headers = new Headers(init?.headers);
        const credentials = await remote.headers?.(options.identity, requestSignal);
        for (const [key, value] of Object.entries(credentials ?? {})) {
          if (
            [
              "host",
              "cookie",
              "mcp-session-id",
              "mcp-protocol-version",
              "content-length",
              "content-type",
              "accept",
            ].includes(key.toLowerCase())
          ) {
            throw new McpError("invalid_configuration");
          }
          headers.set(key, value);
        }
        const response = await remote.fetch(url, {
          ...init,
          headers,
          signal: requestSignal,
          redirect: "manual",
          credentials: "omit",
        });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw new McpError("authentication_required", "none", { httpStatus: response.status });
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new McpError("access_denied");
        }
        if (!response.ok && !(init?.method === "GET" && response.status === 405)) {
          await response.body?.cancel();
          throw new McpError("protocol_failure", "none", { httpStatus: response.status });
        }
        if (!response.body) return response;
        let bytes = 0;
        const bounded = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > limits.maxResponseBytes) {
                controller.error(new McpError("response_limit"));
                return;
              }
              controller.enqueue(chunk);
            },
          })
        );
        return new Response(bounded, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    }),
    limits.maxResponseBytes
  );
}
