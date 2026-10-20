import {
  createCustomMcpSession,
  boundedJson,
  type CustomExecuteInput,
  type CustomToolRevision,
  type Json,
} from '@tulipfarm/provider-mcp';
import { authenticationHeaders, normalizeEndpoint, type McpAuthentication } from './policy.ts';
import { createPublicHttpsFetch } from './public-https.ts';

export {
  authenticationHeaders,
  normalizeEndpoint,
  publicAddress,
  McpNetworkError,
  type McpAuthentication,
} from './policy.ts';
export { publicHttpsFetch } from './public-https.ts';
export * from './oauth.ts';
export * from './registry.ts';
export {
  CUSTOM_MCP_LIMITS,
  CUSTOM_MCP_PROTOCOL_VERSIONS,
  CustomMcpError,
  customToolDigest,
  customToolRevision,
  compareCustomToolRevisions,
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
type ProtocolContext = { endpoint: string; credential: ProtocolCredential; signal: AbortSignal };

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
  }) {
    const endpoint = normalizeEndpoint(input.endpoint);
    const headers = authenticationHeaders(input.authentication);
    const secretValues = [
      ...(input.secrets ?? []),
      ...Object.values(headers).flatMap(value => (value.startsWith('Bearer ') ? [value, value.slice(7)] : [value])),
    ];
    function beforeRequest(signal?: AbortSignal | null) {
      input.signal?.throwIfAborted();
      signal?.throwIfAborted();
      if (input.deadline !== undefined && (!Number.isFinite(input.deadline) || Date.now() >= input.deadline))
        throw new Error('mcp-claim-expired');
    }
    const send = fetcher ?? createPublicHttpsFetch(undefined, input.deadline);
    return createCustomMcpSession({
      endpoint,
      secretValues,
      ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
      ...(input.signal ? { signal: input.signal } : {}),
      fetcher: (url, init) => {
        if (String(url) !== endpoint) throw new Error('mcp-endpoint-denied');
        const authorized = { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } };
        beforeRequest(init?.signal);
        return send(url, authorized);
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
      secrets: credential.kind === 'oauth' ? [credential.refreshToken ?? '', credential.clientSecret ?? ''] : [],
    });
  }
  return {
    async discover(input: ProtocolContext) {
      const client = domainSession(input);
      try {
        return { tools: (await client.discover()).map(protocolTool) };
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
