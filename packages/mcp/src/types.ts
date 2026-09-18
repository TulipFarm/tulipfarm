import type { SandboxIsolationAttestation } from "@tulipfarm/sandbox";
import type { McpIdentity, McpServerDefinition, McpTransport } from "@tulipfarm/schema";

export type { McpIdentity, McpServerDefinition, McpTransport };

export type McpOperation =
  | { readonly type: "connect" | "discover" }
  | {
      readonly type: "callTool";
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "readResource"; readonly uri: string }
  | {
      readonly type: "getPrompt";
      readonly name: string;
      readonly arguments: Readonly<Record<string, string>>;
    };

export interface McpRequestOptions {
  readonly signal?: AbortSignal;
}

export interface McpLimits {
  readonly requestTimeoutMs: number;
  readonly discoveryTimeoutMs: number;
  readonly maxPages: number;
  readonly maxItems: number;
  readonly maxResponseBytes: number;
}

export interface McpTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly execution?: { readonly taskSupport?: "forbidden" | "optional" | "required" };
}

export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpResourceTemplate {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpPrompt {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }[];
}

export type McpToolHandle = McpTool & {
  readonly identity: Readonly<McpIdentity>;
  readonly kind: "tool";
};
export type McpResourceHandle = McpResource & {
  readonly identity: Readonly<McpIdentity>;
  readonly kind: "resource";
};
export type McpResourceTemplateHandle = McpResourceTemplate & {
  readonly identity: Readonly<McpIdentity>;
  readonly kind: "resourceTemplate";
};
export type McpPromptHandle = McpPrompt & {
  readonly identity: Readonly<McpIdentity>;
  readonly kind: "prompt";
};

export interface McpDiscovery {
  readonly tools: readonly McpToolHandle[];
  readonly resources: readonly McpResourceHandle[];
  readonly resourceTemplates: readonly McpResourceTemplateHandle[];
  readonly prompts: readonly McpPromptHandle[];
}

export interface McpServerInfo {
  readonly protocolVersion: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: {
    readonly tools: boolean;
    readonly resources: boolean;
    readonly prompts: boolean;
  };
}

export type McpContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image" | "audio"; readonly data: string; readonly mimeType: string }
  | { readonly type: "resource"; readonly resource: McpResourceContent }
  | ({ readonly type: "resource_link" } & McpResource);

export type McpResourceContent =
  | { readonly uri: string; readonly mimeType?: string; readonly text: string }
  | { readonly uri: string; readonly mimeType?: string; readonly blob: string };

export interface McpToolResult {
  readonly content: readonly McpContent[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

export interface McpPromptResult {
  readonly description?: string;
  readonly messages: readonly {
    readonly role: "user" | "assistant";
    readonly content: McpContent;
  }[];
}

export interface McpRemoteTransport {
  /** Host supplies destination/DNS policy and private-server approval in this transport. */
  readonly fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  readonly headers?: (
    identity: Readonly<McpIdentity>,
    signal: AbortSignal
  ) => Promise<Readonly<Record<string, string>>>;
}

export interface McpStdioProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface McpLocalCredentials {
  readonly environment: (
    identity: Readonly<McpIdentity>,
    signal: AbortSignal
  ) => Promise<Readonly<Record<string, string>>>;
}

export interface IsolatedMcpStdioBackend {
  attestation(): SandboxIsolationAttestation;
  /** A new isolated process and empty credential/cache namespace for every call. */
  open(input: {
    readonly identity: Readonly<McpIdentity>;
    readonly transport: Extract<McpTransport, { type: "stdio" }>;
    readonly signal: AbortSignal;
    readonly maxResponseBytes: number;
    readonly environment: Readonly<Record<string, string>>;
  }): Promise<McpStdioProcess>;
}

export interface McpClientOptions {
  readonly identity: McpIdentity;
  readonly server: McpServerDefinition;
  readonly beforeRequest: (
    identity: Readonly<McpIdentity>,
    operation: McpOperation
  ) => Promise<void>;
  readonly remote?: McpRemoteTransport;
  readonly local?: IsolatedMcpStdioBackend;
  readonly localCredentials?: McpLocalCredentials;
  readonly environment?: "production" | "development";
  readonly limits?: Partial<McpLimits>;
}
