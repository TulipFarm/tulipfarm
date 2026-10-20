import { ChatRound } from 'reicon-react/icons/ChatRound';
import { CreateInChatSample } from '@/components/empty-samples';
import { Link } from '@tanstack/react-router';
import { tableDetailRoute, tableEditRoute, tablesRoute, workspaceRoute } from '@/router';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { TableDetail, TableList } from '@/features/tables/tables';

export function TablesPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const { q } = tablesRoute.useSearch();
  const navigate = tablesRoute.useNavigate();
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <TableList
          key={workspace.id}
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          search={q ?? ''}
          changeSearch={next => void navigate({ search: { q: next || undefined }, replace: true })}
        />
      </PageContent>
    </div>
  );
}

export function TableDetailPage() {
  const { tableId } = tableDetailRoute.useParams();
  const { workspace, sessionId } = workspaceRoute.useRouteContext();
  const search = tableDetailRoute.useSearch();
  const navigate = tableDetailRoute.useNavigate();
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <TableDetail
          key={`${workspace.id}/${tableId}`}
          workspace={{ id: workspace.id, slug: workspace.slug, sessionId }}
          tableId={tableId}
          search={search}
          changeSearch={next => void navigate({ search: current => ({ ...current, ...next }), replace: true })}
        />
      </PageContent>
    </div>
  );
}

export function NewTablePage() {
  return <SchemaInChat />;
}
export function EditTablePage() {
  const { tableId } = tableEditRoute.useParams();
  return <SchemaInChat tableId={tableId} />;
}

function SchemaInChat({ tableId }: { tableId?: string }) {
  const { workspace } = workspaceRoute.useRouteContext();
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          title={tableId ? 'Change table fields' : 'Create a table'}
          back={{
            label: 'Back to tables',
            link: <Link to="/$workspaceSlug/tables" params={{ workspaceSlug: workspace.slug }} />,
          }}
        />
        <StatePanel
          kind="empty"
          icon={ChatRound}
          title="Build tables in chat"
          description="Describe the fields and changes you need to the built-in assistant. Review the exact schema and row effects in your chat before approving execution."
          sample={<CreateInChatSample />}
        >
          <Button
            nativeButton={false}
            render={
              <Link
                to="/$workspaceSlug"
                params={{ workspaceSlug: workspace.slug }}
                search={tableId ? { intent: 'edit-table', tableId } : { intent: 'create-table' }}
              />
            }
          >
            <ChatRound size={16} aria-hidden="true" />
            {tableId ? 'Change fields in chat' : 'Create table in chat'}
          </Button>
        </StatePanel>
      </PageContent>
    </div>
  );
}
