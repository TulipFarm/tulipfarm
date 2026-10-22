import type { Actor } from '@tulipfarm/access';
import type { createAgentRecordTools } from './record-tools.ts';
import type { CreateRecordBatch, ToolCall } from './contracts.ts';

export type TableTools = {
  records: Pick<
    ReturnType<typeof createAgentRecordTools>,
    | 'status'
    | 'inspect'
    | 'listRecords'
    | 'queryRecords'
    | 'summarizeRecords'
    | 'resolveReference'
    | 'reverseRecords'
    | 'createRecord'
    | 'createRecords'
    | 'updateRecord'
    | 'deleteRecord'
    | 'getRecord'
  >;
};
type ToolContext = { workspaceId: string; actor: Actor; callId: string };

export function createToolRegistry(resources: TableTools) {
  const handlers = {
    'schema.inspect': (context: ToolContext, call: Extract<ToolCall, { tool: 'schema.inspect' }>) =>
      resources.records.inspect(context.workspaceId, context.actor, call.tableId),
    'schema.status': (context: ToolContext, call: Extract<ToolCall, { tool: 'schema.status' }>) =>
      resources.records.status(context.workspaceId, context.actor, call.tableId),
    // Saved legacy queries carry no version.
    'rows.list': (context: ToolContext, call: Extract<ToolCall, { tool: 'rows.list' }>) =>
      'version' in call.query
        ? resources.records.queryRecords(
            context.workspaceId,
            context.actor,
            call.tableId,
            call.expectedAppliedRevision,
            { query: call.query, rsql: call.rsql },
          )
        : resources.records.listRecords(
            context.workspaceId,
            context.actor,
            call.tableId,
            call.expectedAppliedRevision,
            call.query,
          ),
    'rows.summarize': (context: ToolContext, call: Extract<ToolCall, { tool: 'rows.summarize' }>) =>
      resources.records.summarizeRecords(
        context.workspaceId,
        context.actor,
        call.tableId,
        call.expectedAppliedRevision,
        call,
      ),
    'rows.resolveReference': (context: ToolContext, call: Extract<ToolCall, { tool: 'rows.resolveReference' }>) =>
      resources.records.resolveReference(
        context.workspaceId,
        context.actor,
        call.tableId,
        call.expectedAppliedRevision,
        call,
      ),
    'rows.reverse': (context: ToolContext, call: Extract<ToolCall, { tool: 'rows.reverse' }>) =>
      resources.records.reverseRecords(context.workspaceId, context.actor, call.tableId, call.recordId, call.fieldId, {
        ...(call.after ? { after: call.after } : {}),
        limit: call.limit,
      }),
    'rows.create': (context: ToolContext, call: Extract<ToolCall, { tool: 'rows.create' }>) =>
      resources.records.createRecord(
        context.workspaceId,
        context.actor,
        call.tableId,
        call.expectedAppliedRevision,
        call.values,
        context.callId,
      ),
    'rows.create.batch': (context: ToolContext, call: CreateRecordBatch) =>
      resources.records.createRecords(context.workspaceId, context.actor, call, context.callId),
    'rows.update': (context: ToolContext, call: Extract<ToolCall, { tool: 'rows.update' }>) =>
      resources.records.updateRecord(
        context.workspaceId,
        context.actor,
        call.tableId,
        call.expectedAppliedRevision,
        call.recordId,
        call.values,
        call.expectedToken,
      ),
    'rows.delete': (context: ToolContext, call: Extract<ToolCall, { tool: 'rows.delete' }>) =>
      resources.records.deleteRecord(
        context.workspaceId,
        context.actor,
        call.tableId,
        call.expectedAppliedRevision,
        call.recordId,
        call.expectedToken,
      ),
    'rows.get': (context: ToolContext, call: Extract<ToolCall, { tool: 'rows.get' }>) =>
      resources.records.getRecord(
        context.workspaceId,
        context.actor,
        call.tableId,
        call.expectedAppliedRevision,
        call.recordId,
      ),
  };

  function invoke(
    context: ToolContext,
    call:
      | CreateRecordBatch
      | Exclude<
          ToolCall,
          {
            tool:
              | 'slack.message.send'
              | 'slack.thread.reply'
              | 'slack.reaction.add'
              | 'google.read'
              | 'google.propose'
              | 'google.status'
              | 'google.execute'
              | 'github.issue.read'
              | 'web.fetch'
              | 'web.search'
              | 'skills.list'
              | 'skills.read'
              | 'tables.list';
          }
        >,
  ) {
    switch (call.tool) {
      case 'schema.inspect':
        return handlers[call.tool](context, call);
      case 'schema.status':
        return handlers[call.tool](context, call);
      case 'rows.list':
        return handlers[call.tool](context, call);
      case 'rows.summarize':
        return handlers[call.tool](context, call);
      case 'rows.resolveReference':
        return handlers[call.tool](context, call);
      case 'rows.reverse':
        return handlers[call.tool](context, call);
      case 'rows.create':
        return handlers[call.tool](context, call);
      case 'rows.create.batch':
        return handlers[call.tool](context, call);
      case 'rows.update':
        return handlers[call.tool](context, call);
      case 'rows.delete':
        return handlers[call.tool](context, call);
      case 'rows.get':
        return handlers[call.tool](context, call);
    }
  }
  return { invoke, names: Object.keys(handlers) };
}
