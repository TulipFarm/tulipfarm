import { tablesRoute, workspaceRoute } from '@/router';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { TableList } from '@/features/tables/table-list';

// The list page loads apart from table detail, so it skips the grid, chart and record editor code.
export function TablesPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const search = tablesRoute.useSearch();
  const navigate = tablesRoute.useNavigate();
  return (
    <PageContent>
      <TableList
        key={workspace.id}
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        search={search}
        changeSearch={next => void navigate({ search: current => ({ ...current, ...next }), replace: true })}
      />
    </PageContent>
  );
}
