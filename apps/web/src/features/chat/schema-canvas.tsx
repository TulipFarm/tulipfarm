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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { useOptionalCanvas, type CanvasItem } from './canvas-state';
import { proposalStatusLabel, useApprovalDockEntries } from './approval-dock';

/** A chat has one schema tab; each proposal, including every revision, opens in it. */
export function schemaCanvasItem(workspaceId: string, chatId: string, proposalId: string, title: string): CanvasItem {
  return { id: `schema:${chatId}`, title, content: { kind: 'schema', workspaceId, chatId, proposalId } };
}

const names = (items: readonly string[]) => items.map(item => item.slice(item.indexOf('/') + 1)).join(', ');

/** Names a revision the assistant left unlabelled by how its fields differ from the version before it. */
function changeLabel(previous: string | undefined, current: string | undefined) {
  if (previous === undefined || current === undefined) return undefined;
  const before = new Set(previous.split('\n').filter(Boolean));
  const after = new Set(current.split('\n').filter(Boolean));
  const added = [...after].filter(field => !before.has(field));
  const removed = [...before].filter(field => !after.has(field));
  if (added.length + removed.length === 0) return 'Adjust field settings';
  if (added.length + removed.length <= 2)
    return added.length && removed.length
      ? `Add ${names(added)}; remove ${names(removed)}`
      : `${added.length ? 'Add' : 'Remove'} ${names(added.length ? added : removed)}`;
  const fields = (n: number) => `${n} field${n === 1 ? '' : 's'}`;
  if (!removed.length) return `Add ${fields(added.length)}`;
  if (!added.length) return `Remove ${fields(removed.length)}`;
  return `Add ${added.length}, remove ${fields(removed.length)}`;
}

function VersionPicker({
  workspaceId,
  chatId,
  proposalId,
}: {
  workspaceId: string;
  chatId: string;
  proposalId: string;
}) {
  const canvas = useOptionalCanvas();
  const versions = useApprovalDockEntries()
    .filter(entry => entry.schema)
    .reverse()
    .map((entry, index, all) => {
      const label =
        entry.label ??
        (index === 0 ? 'First draft' : (changeLabel(all[index - 1]?.fields, entry.fields) ?? 'Revision'));
      return { ...entry, name: `${index + 1}. ${label} · ${proposalStatusLabel(entry.status)}` };
    });
  if (!canvas || versions.length < 2 || !versions.some(version => version.id === proposalId)) return null;
  return (
    <Select
      value={proposalId}
      onValueChange={id => {
        const version = versions.find(item => item.id === id);
        if (version) canvas.show(schemaCanvasItem(workspaceId, chatId, version.id, version.title));
      }}
      items={versions.map(version => ({ value: version.id, label: version.name }))}
    >
      <SelectTrigger width="full" size="sm" aria-label="Choose version">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {versions.map(version => (
          <SelectItem key={version.id} value={version.id}>
            {version.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
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
          superseded: 'Replaced by a newer version',
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
              : view.status === 'superseded'
                ? 'A newer version replaced these changes. Choose the latest version above to review it.'
                : view.status === 'approved' || view.status === 'running'
                  ? 'Follow progress in the approval area at the bottom of the chat.'
                  : 'Check the outcome and available actions in the approval area at the bottom of the chat.';
        return (
          <CanvasSection
            title={title}
            meta={`${count} ${count === 1 ? 'table' : 'tables'} in this proposal · ${links.length} ${links.length === 1 ? 'link' : 'links'}`}
          >
            <VersionPicker workspaceId={workspaceId} chatId={chatId} proposalId={proposalId} />
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
