import { useMemo } from 'react';
import { CanvasSection } from '@tulipfarm/sprout/canvas';
import { Badge } from '@tulipfarm/sprout/badge';
import { SchemaDiagram, SchemaLegend } from '@tulipfarm/sprout/schema-diagram';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { tableApi } from '@/features/tables/api';
import { TableRead } from '@/features/tables/feedback';
import { useTableList, useTableProposal } from '@/features/tables/hooks';
import { proposalApi } from '@/features/tables/proposal-api';
import { proposalSchema } from '@/features/tables/proposal-schema';
import type { TableDefinition } from '@/features/tables/review-contracts';
import type { CanvasItem } from './canvas-state';

export function schemaCanvasItem(workspaceId: string, chatId: string, proposalId: string, title: string): CanvasItem {
  return { id: `schema:${proposalId}`, title, content: { kind: 'schema', workspaceId, chatId, proposalId } };
}

export function SchemaCanvas({
  workspaceId,
  chatId,
  proposalId,
  title,
}: {
  workspaceId: string;
  chatId: string;
  proposalId: string;
  title: string;
}) {
  const api = useMemo(() => proposalApi(workspaceId, chatId, proposalId), [workspaceId, chatId, proposalId]);
  const read = useTableProposal(api, { chatId, proposalId });
  // ponytail: first page of 50 tables only; linked tables beyond it show as "Linked table" without fields.
  const list = useTableList(useMemo(() => tableApi(workspaceId), [workspaceId]));
  const known = useMemo(
    () =>
      new Map<string, TableDefinition>(
        list.state.kind === 'ready' ? list.state.data.tables.map(table => [table.id, table.definition]) : [],
      ),
    [list.state],
  );
  return (
    <TableRead state={read.state} refresh={read.refresh}>
      {view => {
        if (view.content === 'redacted')
          return (
            <StatePanel
              kind="unavailable"
              heading="h3"
              title="Schema no longer available"
              description="Proposal values were removed after the review period. Ask the assistant for a new proposal to see its schema."
            />
          );
        const { tables, links } = proposalSchema(view.manifest.plans, known);
        const count = view.manifest.plans.length;
        const labels = {
          pending: 'Not yet applied',
          approved: 'Approval recorded',
          running: 'Applying changes',
          completed: 'Changes applied',
          partial: 'Partially completed',
          failed: 'Execution failed',
          cancelled: 'Cancelled',
          rejected: 'Rejected',
          expired: 'Expired',
        };
        const variant =
          view.status === 'completed'
            ? 'success'
            : view.status === 'failed' || view.status === 'rejected'
              ? 'destructive'
              : view.status === 'pending' || view.status === 'approved' || view.status === 'running'
                ? 'info'
                : 'warning';
        const footer =
          view.status === 'completed'
            ? 'Changes applied. Open the result from the approval area at the bottom of the chat.'
            : view.status === 'pending'
              ? 'Review these changes, then use the approval area at the bottom of the chat.'
              : view.status === 'approved' || view.status === 'running'
                ? 'Follow progress in the approval area at the bottom of the chat.'
                : 'Check the outcome and available actions in the approval area at the bottom of the chat.';
        return (
          <CanvasSection
            title={title}
            meta={`${count} ${count === 1 ? 'table' : 'tables'} in this proposal · ${links.length} ${links.length === 1 ? 'link' : 'links'}`}
          >
            <div role="status">
              <Badge variant={variant}>{labels[view.status]}</Badge>
            </div>
            <SchemaDiagram tables={tables} links={links} label={`Schema diagram for ${title}`} />
            <SchemaLegend />
            <p className="border-t pt-3 text-sm text-muted-foreground">{footer}</p>
          </CanvasSection>
        );
      }}
    </TableRead>
  );
}
