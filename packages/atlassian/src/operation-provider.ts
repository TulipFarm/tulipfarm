import { z } from 'zod';
import { createAtlassianMcpClient, type AtlassianMcpBinding } from './mcp.ts';
import { createConfluenceTrashClient, createTrelloClient } from './rest.ts';
import { OperationError, digest, type ProviderOperation, type SourceBinding } from './operation-contracts.ts';

export const trustedBindingsSchema = z
  .array(
    z.strictObject({
      operation: z.enum([
        'jira.search',
        'jira.read',
        'jira.create',
        'jira.update',
        'jira.delete',
        'confluence.search',
        'confluence.read',
        'confluence.create',
        'confluence.update',
      ]),
      name: z.string().min(1).max(128),
      contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  )
  .max(9)
  .refine(rows => new Set(rows.map(row => row.operation)).size === rows.length);
export function trustedOperationBindings(env: NodeJS.ProcessEnv = process.env): AtlassianMcpBinding[] {
  if (!env.ATLASSIAN_MCP_TRUSTED_BINDINGS) return [];
  return trustedBindingsSchema.parse(JSON.parse(env.ATLASSIAN_MCP_TRUSTED_BINDINGS));
}
export function operationConfiguration(bindings: readonly AtlassianMcpBinding[], operation: ProviderOperation) {
  const binding = bindings.find(value => value.operation === operation.kind);
  if (
    operation.kind.startsWith('jira.') ||
    (operation.kind.startsWith('confluence.') && operation.kind !== 'confluence.trash')
  ) {
    if (!binding) throw new OperationError('operation-disabled');
    return digest({ adapter: 1, binding });
  }
  return digest({ adapter: 1, operation: operation.kind });
}
export function requireMatchingSource(binding: SourceBinding, operation: ProviderOperation) {
  const matches =
    binding.kind === 'trello'
      ? operation.kind.startsWith('card.')
      : binding.kind === 'confluence-trash'
        ? operation.kind === 'confluence.trash'
        : operation.kind.startsWith(`${binding.kind}.`) && operation.kind !== 'confluence.trash';
  if (!matches) throw new OperationError('operation-conflict');
}
export async function dispatchOperation(options: {
  workspaceId: string;
  userId: string;
  binding: SourceBinding;
  operation: ProviderOperation;
  token: string;
  bindings: readonly AtlassianMcpBinding[];
  authorize: () => Promise<boolean>;
  fetcher?: typeof fetch;
}) {
  const { binding, operation, token, authorize } = options;
  const fetcher = options.fetcher ?? fetch;
  requireMatchingSource(binding, operation);
  switch (operation.kind) {
    case 'card.search':
    case 'card.read':
    case 'card.create':
    case 'card.update':
    case 'card.delete': {
      if (binding.kind !== 'trello') throw new OperationError('operation-conflict');
      return createTrelloClient({
        boardId: binding.boardId,
        credential: { kind: 'oauth2', accessToken: token },
        authorize,
        fetcher,
      }).execute(operation);
    }
    case 'confluence.trash': {
      if (binding.kind !== 'confluence-trash') throw new OperationError('operation-conflict');
      return createConfluenceTrashClient({
        cloudId: binding.cloudId,
        spaceId: binding.spaceId,
        accessToken: token,
        authorize,
        fetcher,
      }).trash(operation.pageId);
    }
    default: {
      if (binding.kind !== 'jira' && binding.kind !== 'confluence') throw new OperationError('operation-conflict');
      const client = createAtlassianMcpClient({
        cloudId: binding.cloudId,
        context: { workspaceId: options.workspaceId, requesterId: options.userId },
        token,
        bindings: options.bindings.filter(value => value.operation === operation.kind),
        authorize,
        fetcher,
      });
      try {
        await client.discover();
        const { kind, ...args } = operation;
        return await client.execute(kind, args);
      } finally {
        await client.close();
      }
    }
  }
}
