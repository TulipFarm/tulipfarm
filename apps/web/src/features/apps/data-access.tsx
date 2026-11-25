import { Fragment, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { toast } from '@tulipfarm/sprout/toast';
import { ChevronDownIcon, DatabaseIcon } from '@tulipfarm/icons';
import { useConfirmation } from '@/features/access/confirm';
import { useMemberDirectory } from '@/features/secrets/queries';
import { tableApi } from '@/features/tables/api';
import { choosableTables, useTablePicker } from '@/features/tables/hooks';
import { TableRequestError } from '@/features/tables/request-state';
import { useFeatureScope } from '@/lib/query';
import { workspaceRoute } from '@/router';
import type { AppDetail, DataView } from './api';
import { AppGate, Loading, useWorkspaceAdmin } from './app-page';
import {
  actionPhrase,
  fieldLabel,
  opLabels,
  tableName,
  unresolvable,
  valueText,
  viewStatus,
  viewSummary,
  type ViewTable,
} from './data-access-labels';
import { DataViewForm } from './data-view-form';
import { canEdit, formatDay } from './labels';
import { useAppApi, useAppChanges, useAppDataViews } from './queries';

export function AppDataAccessPage() {
  return (
    <PageContent>
      <AppGate>{app => <DataAccess app={app} />}</AppGate>
    </PageContent>
  );
}

const notFound = (
  <StatePanel
    kind="unavailable"
    heading="h2"
    icon={DatabaseIcon}
    title="App not found"
    description="This app doesn’t exist, or you no longer have access to it. Check the link, or ask an editor of the app."
  />
);

const noEdit = (
  <StatePanel
    kind="unavailable"
    heading="h2"
    icon={DatabaseIcon}
    title="Only editors can manage data access"
    description="Ask an editor of this app for edit access."
  />
);

const noRights =
  'You can’t share this table. You need Manage schema on it, plus Read rows, Create rows, Update rows or Delete rows for each action you allow. Ask a workspace admin for access.';
const noEditAction = 'You need edit access to this app to share or stop sharing data views. Ask an editor of this app.';
const adminOnly = 'Only a workspace admin can approve data access.';
const viewChanged = 'This data view or its table was removed or changed. The list now shows its current state.';

function DataAccess({ app }: { app: AppDetail }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const admin = useWorkspaceAdmin(workspace.id);
  const editor = canEdit(app);
  const reachable = app.kind === 'public' && (editor || admin);
  const views = useAppDataViews(workspace.id, app.id, reachable);
  const tablesApi = useMemo(() => tableApi(workspace.id), [workspace.id]);
  const tables = useTablePicker(tablesApi, app.kind === 'public' && editor);
  const directory = useMemberDirectory(workspace.id);
  const api = useAppApi(workspace.id);
  const changes = useAppChanges();
  const [creating, setCreating] = useState(false);

  const readableTables = tables.state.kind === 'ready' ? choosableTables(tables.state.data) : [];
  const members = directory.state.kind === 'ready' ? directory.state.data : [];
  const nameOf = (membershipId: string | null) =>
    members.find(member => member.id === membershipId)?.name ?? 'A former member';

  const create = editor && <Button onClick={() => setCreating(true)}>Create data view</Button>;

  const body = (() => {
    if (app.kind !== 'public') return notFound;
    if (!reachable) return noEdit;
    const state = views.state;
    if (state.kind === 'unavailable') return state.status === 403 ? noEdit : notFound;
    if (state.kind === 'loading') return <Loading label="Loading data access…" />;
    if (state.kind === 'error')
      return (
        <StatePanel kind="error" heading="h2" title="Couldn’t load data access." description={null}>
          <Button variant="outline" onClick={() => void views.refresh()}>
            Try again
          </Button>
        </StatePanel>
      );
    if (!state.data.length)
      return (
        <StatePanel
          kind="empty"
          heading="h2"
          icon={DatabaseIcon}
          title="No data views yet"
          description="This app can’t use any workspace data. Create a data view to let it read or change rows in one table."
        >
          {create}
        </StatePanel>
      );
    return (
      <ul className="space-y-4" aria-label="Data views">
        {state.data.map(view => (
          <li key={view.id}>
            <ViewCard view={view} app={app} table={view.table} nameOf={nameOf} editor={editor} admin={admin} />
          </li>
        ))}
      </ul>
    );
  })();

  const listed = views.state.kind === 'ready' && views.state.data.length > 0;
  return (
    <>
      <PageHeader
        titleId="data-access-heading"
        focusable
        title="Data access"
        description="A data view lets this public app use chosen fields and rows from one table. Without one, the app can’t reach any workspace data."
        parent={{
          label: app.title,
          link: (
            <Link to="/$workspaceSlug/apps/$appSlug" params={{ workspaceSlug: workspace.slug, appSlug: app.slug }} />
          ),
        }}
        actions={reachable && listed ? create : undefined}
      />
      {body}
      {editor && (
        <DataViewForm
          tables={readableTables}
          open={creating}
          onOpenChange={setCreating}
          create={async draft => {
            try {
              await api.createDataView(app.id, draft);
            } finally {
              await changes.dataViews(app.id);
            }
          }}
        />
      )}
    </>
  );
}

function ViewCard({
  view,
  app,
  table,
  nameOf,
  editor,
  admin,
}: {
  view: DataView;
  app: AppDetail;
  table: ViewTable;
  nameOf: (membershipId: string | null) => string;
  editor: boolean;
  admin: boolean;
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useAppApi(workspace.id);
  const changes = useAppChanges();
  const confirm = useConfirmation();
  const scope = useFeatureScope();
  const me = scope.kind === 'workspace' ? scope.membershipId : null;
  const [open, setOpen] = useState(false);
  const status = viewStatus(view, app, table);
  const name = tableName(table);
  const actions = actionPhrase(view.actions);
  const shared = view.sharedBy !== null;
  const approved = view.approvedBy !== null;
  const broken = unresolvable(view);

  /** Runs a change, refreshes the list either way, and names a refusal the dialog can show. */
  const attempt = async (work: () => Promise<unknown>, refusals: Record<string, string | (() => Promise<string>)>) => {
    try {
      await work();
      return null;
    } catch (error) {
      const refusal = error instanceof TableRequestError ? refusals[error.code] : undefined;
      if (refusal) return typeof refusal === 'string' ? refusal : await refusal();
      return error instanceof TableRequestError
        ? 'Nothing has changed. Try again.'
        : 'We couldn’t confirm the change. Check the list before trying again.';
    } finally {
      await changes.dataViews(app.id);
    }
  };

  const share = () =>
    confirm.open({
      title: `Share ${name} data view with this app?`,
      description: `After a workspace admin approves, this app can ${actions} rows in ${name} as this view allows. Access continues when you publish new versions. The app uses its own access, not yours.`,
      action: 'Share',
      destructive: false,
      run: async () => {
        const reason = await attempt(() => api.shareDataView(app.id, view.id), {
          // The API refuses a missing or broken view the same way as a sharer without rights, so look again.
          'not-found': async () => {
            const views = await api.dataViews(app.id, AbortSignal.timeout(15_000)).catch(() => []);
            const fresh = views.find(entry => entry.id === view.id);
            return fresh && !unresolvable(fresh) ? noRights : viewChanged;
          },
          forbidden: noEditAction,
        });
        if (reason === null) toast.add({ title: 'Shared. Waiting for a workspace admin to approve.', type: 'success' });
        return reason;
      },
    });

  const approve = () =>
    confirm.open({
      title: `Approve ${name} data view?`,
      description: `This app can then ${actions} rows in ${name} as this view allows, including in versions published later. The app’s code sees every visitor’s data and could mix it up between visitors. Your name is recorded as the approver.`,
      action: 'Approve',
      destructive: false,
      run: async () => {
        let approver: string | null = null;
        const reason = await attempt(
          async () => {
            approver = (await api.approveDataView(app.id, view.id)).approvedBy;
          },
          { 'not-found': viewChanged, forbidden: adminOnly },
        );
        if (reason === null)
          toast.add({
            title: approver !== null && approver !== me ? `Already approved by ${nameOf(approver)}.` : 'Approved.',
            type: 'success',
          });
        return reason;
      },
    });

  const stopSharing = () =>
    confirm.open({
      title: `Stop sharing ${name} data view?`,
      description:
        'The app loses access to this view right away. Data it already received isn’t recalled. Restoring an earlier version won’t bring access back. Sharing it again needs a new approval.',
      action: 'Stop sharing',
      run: async () => {
        const reason = await attempt(() => api.stopSharingDataView(app.id, view.id), { forbidden: noEditAction });
        if (reason === null)
          toast.add({ title: 'Stopped sharing. The app can no longer use this data view.', type: 'success' });
        return reason;
      },
    });

  return (
    <article aria-label={`${name} data view`} className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="font-medium">{viewSummary(view, table)}</h2>
          <p className="text-sm">
            <Badge variant={status.tone}>{status.badge}</Badge> {status.sentence}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!shared && !broken && editor && (
            <Button variant="outline" size="sm" onClick={share}>
              Share with this app
            </Button>
          )}
          {shared && !approved && !broken && admin && (
            <Button size="sm" aria-label={`Approve ${name} data view`} onClick={approve}>
              Approve
            </Button>
          )}
          {shared && (editor || admin) && (
            <Button
              variant="ghost-destructive"
              size="sm"
              aria-label={`Stop sharing ${name} data view`}
              onClick={stopSharing}
            >
              Stop sharing
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-1 text-sm text-muted-foreground">
        <p>
          Created by {nameOf(view.createdBy)} on {formatDay(view.createdAt)}
        </p>
        {shared && view.sharedAt && (
          <p>
            Shared by {nameOf(view.sharedBy)} on {formatDay(view.sharedAt)}
          </p>
        )}
        {approved && view.approvedAt && (
          <p>
            Approved by {nameOf(view.approvedBy)} on {formatDay(view.approvedAt)}
          </p>
        )}
        {shared && !approved && !admin && <p>{adminOnly}</p>}
      </div>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          render={
            <Button variant="ghost" size="sm" aria-label={`${open ? 'Hide' : 'Show'} details for ${name} data view`} />
          }
        >
          <ChevronDownIcon aria-hidden />
          {open ? 'Hide details' : 'Show details'}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-1 pt-2 text-sm">
            <p>Fields: {view.fieldIds.map(fieldId => fieldLabel(table, fieldId)).join(', ')}</p>
            <p>{rowsText(view, table)}</p>
          </div>
        </CollapsibleContent>
      </Collapsible>
      {confirm.element}
    </article>
  );
}

function rowsText(view: DataView, table: ViewTable) {
  if (!view.predicate.all.length) return 'All rows';
  const rules = view.predicate.all.map((comparison, index) => {
    const field = fieldLabel(table, comparison.fieldId);
    const op = opLabels[comparison.op];
    const rule = (() => {
      if (!('operand' in comparison)) return `${field} ${op}`;
      if (comparison.operand.kind === 'parameter')
        return (
          <>
            {field} {op} the value the app sends as <code className="font-mono">{comparison.operand.name}</code>
          </>
        );
      return `${field} ${op} “${valueText(table, comparison)}”`;
    })();
    return (
      <Fragment key={index}>
        {index > 0 && ' and '}
        {rule}
      </Fragment>
    );
  });
  return <>Rows where {rules}</>;
}
