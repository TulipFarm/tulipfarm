import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  IntegrationConnection,
  IntegrationManifest,
  Logger,
  McpEntry,
  SoulIntegration,
} from "@tulipfarm/soul";
import type { ToolRegistry } from "../tools/registry";
import type { ToolDef } from "../tools/types";
import { ok, err as toolErr } from "../tools/types";

export type McpConnectionStatus = "connecting" | "connected" | "error" | "disconnected";

interface ConnectionEntry {
  client: Client;
  transport: { close(): Promise<void> };
  status: McpConnectionStatus;
  errorMessage?: string;
  toolNames: string[];
}

function integrationToolName(integrationName: string, mcpToolName: string): string {
  return `integration_${integrationName}_${mcpToolName}`;
}

function buildToolDefs(
  integrationName: string,
  mcpTools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>,
  callFn: (toolName: string, args: unknown) => Promise<ReturnType<typeof ok | typeof toolErr>>
): ToolDef[] {
  return mcpTools.map((t) => ({
    name: integrationToolName(integrationName, t.name),
    tier: "integration" as const,
    mutating: true, // conservative: MCP tools may mutate; individual tools can't declare otherwise
    description: t.description ?? `${integrationName}: ${t.name}`,
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    execute: async (args: unknown) => callFn(t.name, args),
  }));
}

/**
 * Manages MCP client connections for `type: mcp` integrations. Lifecycle:
 *   startAll() → connect all enabled soul integrations at startup
 *   connect()  → start a single integration (also called by the connect route)
 *   disconnect() → stop and unregister
 *
 * Crash isolation: a server crash marks the entry as `error` but never throws to the caller.
 */
export class McpClientService {
  private readonly connections = new Map<string, ConnectionEntry>();
  private registry: ToolRegistry | null = null;

  constructor(private readonly logger: Logger) {}

  /** Called once after ToolRegistry is built. McpClientService then registers/unregisters tools directly. */
  setRegistry(registry: ToolRegistry): void {
    this.registry = registry;
  }

  /** Connect all soul integrations that have connection.enabled = true. Non-fatal on individual failures. */
  async startAll(integrations: Map<string, SoulIntegration>): Promise<void> {
    for (const integration of integrations.values()) {
      if (integration.connection?.enabled) {
        try {
          await this.connect(integration.name, integration.manifest, integration.connection);
        } catch (e) {
          this.logger.warn(
            `MCP: failed to start integration "${integration.name}" at startup — ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    }
  }

  getStatus(name: string): McpConnectionStatus {
    return this.connections.get(name)?.status ?? "disconnected";
  }

  getStatusAll(): Map<string, McpConnectionStatus> {
    const out = new Map<string, McpConnectionStatus>();
    for (const [name, entry] of this.connections) out.set(name, entry.status);
    return out;
  }

  getErrorMessage(name: string): string | undefined {
    return this.connections.get(name)?.errorMessage;
  }

  getToolNames(name: string): string[] {
    return this.connections.get(name)?.toolNames ?? [];
  }

  async connect(
    name: string,
    manifest: IntegrationManifest,
    connection: IntegrationConnection
  ): Promise<void> {
    // Disconnect existing connection first (idempotent re-connect)
    if (this.connections.has(name)) await this.disconnect(name);

    const entry: ConnectionEntry = {
      client: new Client({ name: "tulipfarm", version: "1" }),
      transport: null as unknown as { close(): Promise<void> },
      status: "connecting",
      toolNames: [],
    };
    this.connections.set(name, entry);

    try {
      const transport = buildTransport(manifest.entry, connection.env ?? {});
      entry.transport = transport;

      // Crash isolation: if the server closes unexpectedly, mark as error
      entry.client.onclose = () => {
        const e = this.connections.get(name);
        if (e && e.status === "connected") {
          e.status = "error";
          e.errorMessage = "MCP server closed unexpectedly";
          this.logger.warn(`MCP: server "${name}" closed unexpectedly`);
          if (this.registry) {
            for (const toolName of e.toolNames) this.registry.unregister(toolName);
          }
          e.toolNames = [];
        }
      };

      await entry.client.connect(transport);

      const { tools } = await entry.client.listTools();
      const mcpTools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));

      const toolDefs = buildToolDefs(name, mcpTools, (toolName, args) =>
        this.callTool(name, toolName, args)
      );

      if (this.registry) {
        for (const def of toolDefs) this.registry.register(def);
      }

      entry.toolNames = toolDefs.map((d) => d.name);
      entry.status = "connected";

      this.logger.info(`MCP: integration "${name}" connected (${tools.length} tool(s))`);
    } catch (e) {
      entry.status = "error";
      entry.errorMessage = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async disconnect(name: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry) return;

    if (this.registry) {
      for (const toolName of entry.toolNames) this.registry.unregister(toolName);
    }
    entry.toolNames = [];
    entry.status = "disconnected";

    try {
      await entry.transport?.close();
    } catch {
      // best-effort close
    }
    try {
      await entry.client?.close();
    } catch {
      // best-effort close
    }

    this.connections.delete(name);
    this.logger.info(`MCP: integration "${name}" disconnected`);
  }

  private async callTool(
    integrationName: string,
    toolName: string,
    args: unknown
  ): Promise<ReturnType<typeof ok> | ReturnType<typeof toolErr>> {
    const entry = this.connections.get(integrationName);
    if (entry?.status !== "connected") {
      return toolErr(
        "internal_error",
        `integration "${integrationName}" is not connected (status: ${entry ? entry.status : "disconnected"})`
      );
    }
    try {
      const result = await entry.client.callTool({
        name: toolName,
        arguments: args as Record<string, unknown>,
      });
      return ok(result);
    } catch (e) {
      return toolErr("internal_error", e instanceof Error ? e.message : String(e));
    }
  }
}

function buildTransport(
  entry: McpEntry,
  env: Record<string, string>
): { close(): Promise<void> } & Parameters<Client["connect"]>[0] {
  if (entry.transport === "stdio") {
    return new StdioClientTransport({
      command: entry.command,
      args: entry.args ?? [],
      env: { ...process.env, ...env } as Record<string, string>,
      stderr: "pipe",
    });
  }
  // SSE / StreamableHTTP
  const url = new URL(entry.url);
  const headers: Record<string, string> = { ...(entry.headers ?? {}), ...env };
  return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}
