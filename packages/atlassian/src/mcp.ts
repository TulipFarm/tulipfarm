import { createMcpSession, jsonCopy, type McpErrorCode, type ReadonlyJson } from '@tulipfarm/provider-mcp';
import { z } from 'zod';

export { toolContractDigest } from '@tulipfarm/provider-mcp';
export const atlassianMcpEndpoint = 'https://mcp.atlassian.com/v2/mcp?tools=all';
const operationSchema = z.enum([
  'jira.search',
  'jira.read',
  'jira.create',
  'jira.update',
  'jira.delete',
  'confluence.search',
  'confluence.read',
  'confluence.create',
  'confluence.update',
]);
export type AtlassianOperation = z.infer<typeof operationSchema>;
const officialNames: Readonly<Record<AtlassianOperation, string>> = {
  'jira.search': 'searchJiraIssuesUsingJql',
  'jira.read': 'getJiraIssue',
  'jira.create': 'createJiraIssue',
  'jira.update': 'editJiraIssue',
  'jira.delete': 'deleteJiraIssue',
  'confluence.search': 'searchConfluence',
  'confluence.read': 'getConfluenceContent',
  'confluence.create': 'createConfluenceContent',
  'confluence.update': 'updateConfluenceContent',
};
const contextId = z.string().min(1).max(256);
const contextSchema = z.strictObject({ workspaceId: contextId, requesterId: contextId });
const bindingSchema = z.strictObject({
  operation: operationSchema,
  name: z.string().min(1).max(128),
  contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AtlassianMcpContext = z.infer<typeof contextSchema>;
export type AtlassianMcpBinding = z.infer<typeof bindingSchema>;
export type AtlassianAuthorization = {
  readonly cloudId: string;
  readonly context: Readonly<AtlassianMcpContext>;
  readonly operation: AtlassianOperation;
  readonly arguments: Readonly<Record<string, ReadonlyJson>>;
};
export type AtlassianMcpErrorCode = McpErrorCode;

export class AtlassianMcpError extends Error {
  readonly code: AtlassianMcpErrorCode;

  constructor(code: AtlassianMcpErrorCode) {
    super(`atlassian-mcp-${code}`);
    this.name = 'AtlassianMcpError';
    this.code = code;
  }
}

export type AtlassianMcpResult = {
  readonly untrusted: true;
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: Readonly<Record<string, ReadonlyJson>>;
};

export function createAtlassianMcpClient(options: {
  cloudId: string;
  context: AtlassianMcpContext;
  token: string;
  bindings: readonly AtlassianMcpBinding[];
  authorize: (request: AtlassianAuthorization) => Promise<boolean>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}) {
  const parsedCloudId = z.uuid().safeParse(options.cloudId);
  const parsedContext = contextSchema.safeParse(options.context);
  const parsedBindings = z.array(bindingSchema).max(9).safeParse(options.bindings);
  const timeoutMs = options.timeoutMs ?? 15000;
  if (
    !parsedCloudId.success ||
    !parsedContext.success ||
    !parsedBindings.success ||
    typeof options.token !== 'string' ||
    options.token.length > 16384 ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(options.token) ||
    typeof options.authorize !== 'function'
  ) {
    throw new AtlassianMcpError('configuration');
  }
  if (parsedBindings.data.some(binding => officialNames[binding.operation] !== binding.name)) {
    throw new AtlassianMcpError('configuration');
  }
  const cloudId = parsedCloudId.data;
  const context = Object.freeze(parsedContext.data);
  const authorize = options.authorize;
  const fetcher = options.fetcher ?? fetch;
  const token = options.token;
  return createMcpSession({
    endpoint: atlassianMcpEndpoint,
    clientName: 'tulipfarm-atlassian',
    token,
    timeoutMs,
    bindings: parsedBindings.data,
    error: code => new AtlassianMcpError(code),
    knownError: error => (error instanceof AtlassianMcpError ? new AtlassianMcpError(error.code) : null),
    fetcher: async (url, init) => {
      if (init?.method !== 'POST') throw new Error('unexpected-request');
      const response = await fetcher(url, init);
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400) ||
        [401, 403, 429].includes(response.status)
      ) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new AtlassianMcpError('provider-auth-rejected');
        if (response.status === 429) throw new AtlassianMcpError('rate-limited');
        throw new Error('unexpected-redirect');
      }
      return response;
    },
    prepareArguments: args => {
      if (Object.hasOwn(args, 'cloudId') && args.cloudId !== cloudId) throw new AtlassianMcpError('invalid-arguments');
      args.cloudId = cloudId;
    },
    inspectCatalog: page => {
      if (JSON.stringify(page).includes(token)) throw new AtlassianMcpError('catalog-invalid');
    },
    authorize: (operation, args) => authorize(Object.freeze({ cloudId, context, operation, arguments: args })),
    result: (result): AtlassianMcpResult => {
      if (JSON.stringify(result).includes(token)) throw new AtlassianMcpError('outcome-unknown');
      const content = result.content.map(item => {
        if (item.type !== 'text') throw new AtlassianMcpError('outcome-unknown');
        return { type: item.type, text: item.text };
      });
      const structuredContent = result.structuredContent === undefined ? undefined : jsonCopy(result.structuredContent);
      if (
        structuredContent !== undefined &&
        (!structuredContent || typeof structuredContent !== 'object' || Array.isArray(structuredContent))
      ) {
        throw new AtlassianMcpError('outcome-unknown');
      }
      return { untrusted: true, content, ...(structuredContent === undefined ? {} : { structuredContent }) };
    },
  });
}
