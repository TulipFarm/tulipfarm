import type { McpClient } from "@tulipfarm/mcp";
import type { McpExecutionBinding, McpServerDefinition } from "@tulipfarm/schema";
import type { McpIntegrationDefinition } from "./definition";

export type McpSession = Pick<
  McpClient,
  "connect" | "discover" | "callTool" | "readResource" | "getPrompt" | "close"
>;

export interface McpCaller {
  readonly principal: { readonly kind: string; readonly id: string };
  readonly runId?: string;
  readonly conversationId?: string;
  readonly routineId?: string;
  readonly accountId?: string;
  readonly knowledgeSyncId?: string;
}

export type { McpExecutionBinding } from "@tulipfarm/schema";

export type McpCapability =
  | { readonly kind: "tool"; readonly name: string }
  | { readonly kind: "resource"; readonly name: string }
  | { readonly kind: "prompt"; readonly name: string }
  | { readonly kind: "discovery"; readonly name: "*" };

export interface McpAccountAccess {
  bind(input: {
    readonly caller: McpCaller;
    readonly server: McpServerDefinition;
    readonly serverRevision: string;
    readonly capability: McpCapability;
    readonly pinned?: McpExecutionBinding;
  }): Promise<McpExecutionBinding>;
  revalidate(binding: McpExecutionBinding, capability: McpCapability): Promise<void>;
  /** Keep the session and all credential-bearing work inside the host's credential lease. */
  use<T>(
    binding: McpExecutionBinding,
    server: McpServerDefinition,
    callback: (session: McpSession) => Promise<T>
  ): Promise<T>;
}

export interface McpDefinitionStore<Actor> {
  list(): readonly McpIntegrationDefinition[];
  get(id: string): McpIntegrationDefinition | undefined;
  put(
    definition: McpIntegrationDefinition,
    actor: Actor,
    expectedRevision?: string | null
  ): Promise<void>;
  remove(id: string, actor: Actor, expectedRevision?: string | null): Promise<void>;
}

export interface McpAccessAudit {
  record(input: {
    readonly serverId: string;
    readonly caller: McpCaller;
    readonly capability: McpCapability;
    readonly accountId?: string | null;
    readonly outcome: "allowed" | "refused" | "failed";
    readonly code?: string;
  }): Promise<void>;
}
