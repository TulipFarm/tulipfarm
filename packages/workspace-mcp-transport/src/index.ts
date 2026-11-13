import {
  createCustomMcpSession,
  boundedJson,
  CUSTOM_MCP_LIMITS,
  type CustomExecuteInput,
  type CustomMcpTransport,
  type CustomToolRevision,
  type Json,
} from '@tulipfarm/provider-mcp';
import { authenticationHeaders, normalizeEndpoint, type McpAuthentication } from './policy.ts';
import { createPublicHttpsFetch } from './public-https.ts';

export {
  authenticationHeaders,
  listedPrivateHost,
  normalizeDestination,
  normalizeEndpoint,
  parsePrivateHosts,
  publicAddress,
  McpNetworkError,
  type DestinationAddresses,
  type McpAuthentication,
  type McpNetworkErrorDetail,
  type PrivateHost,
} from './policy.ts';
export {
  pinnedRequest,
  publicHttpsFetch,
  type PinnedRequestInit,
  type PinnedRequestPolicy,
  type PinnedResponse,
} from './public-https.ts';
export * from './oauth.ts';
export * from './registry.ts';
export {
  CUSTOM_MCP_LIMITS,
  CUSTOM_MCP_PROTOCOL_VERSIONS,
  CustomMcpError,
  CUSTOM_MCP_LEGACY_PROTOCOL_VERSION,
  customToolDigest,
  customToolRevision,
  compareCustomToolRevisions,
  type CustomMcpTransport,
  type CustomToolRevision,
  type CustomToolResult,
} from '@tulipfarm/provider-mcp';

type ProtocolTool = {
  name: string;
  description: string;
  inputSchema: Record<string, Json>;
  outputSchema?: Record<string, Json>;
  annotations?: Record<string, Json>;
  execution?: Record<string, Json>;
};
type ProtocolCredential =
  | McpAuthentication
  | {
      kind: 'oauth';
      accessToken: string;
      refreshToken: string | null;
      expiresAt: string;
      issuer: string;
      resource: string;
      clientId: string;
      clientSecret?: string;
      scopes: string[];
      accountId: string | null;
    };
/** A hosted server's running sandbox, reached at a URL its host returned instead of the public endpoint. */
type HostTarget = { endpoint: string; headers: Record<string, string> };
type ProtocolContext = {
  endpoint: string;
  credential: ProtocolCredential;
  signal: AbortSignal;
  hostTarget?: HostTarget;
  /** The transport an earlier discovery detected. Without it, the session detects it again. */
  transport?: CustomMcpTransport;
};
// An HTTP+SSE stream carries every response of a call: two tool catalogs and the result, within those deadlines.
const legacyStreamPolicy = {
  maximumBytes: 2 * CUSTOM_MCP_LIMITS.catalogBytes + CUSTOM_MCP_LIMITS.responseBytes + 1048576,
  redirects: 'deny' as const,
  timeoutMs: 2 * CUSTOM_MCP_LIMITS.discoveryMs + CUSTOM_MCP_LIMITS.callMs,
};

/** The host decides where its sandboxes listen, so this accepts that exact URL only and never follows redirects. */
function hostTargetUrl(input: string) {
  const url = new URL(input);
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.hash)
    throw new Error('mcp-endpoint-denied');
  return url.href;
}

function protocolTool(tool: CustomToolRevision): ProtocolTool {
  function object(value: unknown): Record<string, Json> {
    const copy = boundedJson(value, 2097152);
    if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new Error('mcp-catalog-invalid');
    return copy;
  }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: object(tool.inputSchema),
    ...(tool.outputSchema ? { outputSchema: object(tool.outputSchema) } : {}),
    ...(tool.annotations ? { annotations: object(tool.annotations) } : {}),
    ...(tool.execution ? { execution: object(tool.execution) } : {}),
  };
}

export function createWorkspaceMcpTransport({ fetcher }: { fetcher?: typeof fetch } = {}) {
  function session(input: {
    endpoint: string;
    authentication: McpAuthentication;
    signal?: AbortSignal;
    secrets?: string[];
    deadline?: number;
    hostTarget?: HostTarget;
    transport?: CustomMcpTransport | 'auto';
  }) {
    const endpoint = input.hostTarget ? hostTargetUrl(input.hostTarget.endpoint) : normalizeEndpoint(input.endpoint);
    const origin = new URL(endpoint).origin;
    const headers = { ...authenticationHeaders(input.authentication), ...input.hostTarget?.headers };
    const secretValues = [
      ...(input.secrets ?? []),
      ...Object.entries(headers).flatMap(([name, value]) =>
        name === 'cookie'
          ? [value, ...value.split('; ').map(pair => pair.slice(pair.indexOf('=') + 1))]
          : value.startsWith('Bearer ')
            ? [value, value.slice(7)]
            : [value],
      ),
    ];
    function beforeRequest(signal?: AbortSignal | null) {
      input.signal?.throwIfAborted();
      signal?.throwIfAborted();
      if (input.deadline !== undefined && (!Number.isFinite(input.deadline) || Date.now() >= input.deadline))
        throw new Error('mcp-claim-expired');
    }
    const send = input.hostTarget
      ? (url: string | URL | Request, init?: RequestInit) => (fetcher ?? fetch)(url, { ...init, redirect: 'error' })
      : (fetcher ?? createPublicHttpsFetch(undefined, input.deadline));
    const stream = input.hostTarget
      ? send
      : (fetcher ?? createPublicHttpsFetch(undefined, input.deadline, legacyStreamPolicy));
    return createCustomMcpSession({
      endpoint,
      secretValues,
      // Hosted sandboxes always speak Streamable HTTP.
      transport: input.hostTarget ? 'streamable-http' : (input.transport ?? 'auto'),
      ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
      ...(input.signal ? { signal: input.signal } : {}),
      fetcher: (url, init) => {
        // An HTTP+SSE server posts messages to a URL it names, which may only differ from the endpoint in path and query.
        if (String(url) !== endpoint && (input.hostTarget || new URL(String(url)).origin !== origin))
          throw new Error('mcp-endpoint-denied');
        const authorized = { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } };
        beforeRequest(init?.signal);
        return (init?.method === 'GET' ? stream : send)(url, authorized);
      },
    });
  }
  function domainSession(input: ProtocolContext & { deadline?: number }) {
    const credential = input.credential;
    if (
      credential.kind === 'oauth' &&
      (normalizeEndpoint(credential.resource) !== normalizeEndpoint(input.endpoint) ||
        !Number.isFinite(Date.parse(credential.expiresAt)) ||
        Date.parse(credential.expiresAt) <= Date.now())
    )
      throw new Error('mcp-credential-unavailable');
    return session({
      endpoint: input.endpoint,
      authentication: credential.kind === 'oauth' ? { kind: 'bearer', token: credential.accessToken } : credential,
      signal: input.signal,
      ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
      ...(input.hostTarget ? { hostTarget: input.hostTarget } : {}),
      ...(input.transport ? { transport: input.transport } : {}),
      secrets: credential.kind === 'oauth' ? [credential.refreshToken ?? '', credential.clientSecret ?? ''] : [],
    });
  }
  return {
    /** Detects the transport again, ignoring any recorded one, and returns it with the tools. */
    async discover(input: ProtocolContext) {
      const { transport: _recorded, ...rest } = input;
      const client = domainSession(rest);
      try {
        const tools = (await client.discover()).map(protocolTool);
        const transport = client.transport();
        return { tools, ...(transport ? { transport } : {}) };
      } finally {
        client.close();
      }
    },
    async call(
      input: ProtocolContext & {
        tool: ProtocolTool;
        arguments: Record<string, Json>;
        requestId: string;
        deadline: number;
        authorize: () => Promise<void>;
      },
    ) {
      if (!Number.isFinite(input.deadline)) throw new Error('mcp-claim-expired');
      const expected = JSON.stringify(boundedJson(input.tool, 2097152));
      const args = boundedJson(input.arguments, 131072);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('mcp-invalid-arguments');
      const name = input.tool.name;
      const requestId = input.requestId;
      const client = domainSession(input);
      try {
        const tool = (await client.discover()).find(tool => tool.name === name);
        if (!tool || JSON.stringify(boundedJson(protocolTool(tool), 2097152)) !== expected)
          throw new Error('mcp-tool-drift');
        return await client.execute({
          name: tool.name,
          digest: tool.digest,
          arguments: args,
          requestId,
          authorize: async revision => {
            await input.authorize();
            return JSON.stringify(boundedJson(protocolTool(revision), 2097152)) === expected;
          },
        });
      } finally {
        client.close();
      }
    },
    async execute(input: { endpoint: string; authentication: McpAuthentication } & CustomExecuteInput) {
      const client = session(input);
      try {
        return await client.execute(input);
      } finally {
        client.close();
      }
    },
  };
}
