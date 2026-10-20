import type { HumanActor } from '@tulipfarm/access';
import type { SourceDependency } from '@tulipfarm/conversations/results';
import type { AgentStorage } from './store.ts';
import type { McpCall, McpExecutionResult, McpModelCatalog } from './mcp-contracts.ts';

export type McpExecutionOrigin =
  | { kind: 'private-chat'; conversationId: string; turnId: string; stepId: string }
  | { kind: 'named-task'; taskId: string; stepId: string };
export type McpExecutionContext = { workspaceId: string; actor: HumanActor; origin: McpExecutionOrigin };
export type McpExecutionPort = {
  recover(workspaceId: string): Promise<void>;
  catalog(
    context: McpExecutionContext,
    described?: readonly string[],
  ): Promise<{ model: McpModelCatalog; sources: SourceDependency[] }>;
  execute(
    context: McpExecutionContext,
    callId: string,
    call: McpCall,
  ): Promise<{ result: McpExecutionResult; sources: SourceDependency[] }>;
  resume(
    context: McpExecutionContext,
    actionId: string,
  ): Promise<{ result: McpExecutionResult; sources: SourceDependency[] }>;
};
export type McpExecutionFactory = (runtime: AgentStorage) => McpExecutionPort;
