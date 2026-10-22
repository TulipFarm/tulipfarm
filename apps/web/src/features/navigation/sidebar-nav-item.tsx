import { useState } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import type { Page } from '@/pages/workspace';
import { useSidebar } from '@tulipfarm/sprout/sidebar';
import { SidebarRecentItem } from './sidebar-recent-item';
import { useRecentItems, type RecentItem, type RecentSection } from './recent-queries';

function itemLink(section: RecentSection, slug: string, item: RecentItem) {
  switch (section) {
    case 'chat':
      return (
        <Link to="/$workspaceSlug/chat/$chatId" params={{ workspaceSlug: slug, chatId: item.id }} preload={false} />
      );
    case 'projects':
      return (
        <Link
          to="/$workspaceSlug/projects/$projectId"
          params={{ workspaceSlug: slug, projectId: item.id }}
          preload={false}
        />
      );
    case 'agents':
      return (
        <Link to="/$workspaceSlug/agents/$agentId" params={{ workspaceSlug: slug, agentId: item.id }} preload={false} />
      );
    case 'agent-tasks':
      return (
        <Link
          to="/$workspaceSlug/agent-tasks/$taskId"
          params={{ workspaceSlug: slug, taskId: item.id }}
          preload={false}
        />
      );
    case 'workflows':
      return (
        <Link
          to="/$workspaceSlug/workflows"
          params={{ workspaceSlug: slug }}
          search={{ workflow: item.id }}
          preload={false}
        />
      );
    case 'tables':
      return (
        <Link to="/$workspaceSlug/tables/$tableId" params={{ workspaceSlug: slug, tableId: item.id }} preload={false} />
      );
    case 'files':
      return (
        <Link to="/$workspaceSlug/files/$fileId" params={{ workspaceSlug: slug, fileId: item.id }} preload={false} />
      );
  }
}

export function SidebarNavItem({
  page,
  section,
  workspaceId,
  slug,
  onIntent,
}: {
  page: Page;
  section: RecentSection;
  workspaceId: string;
  slug: string;
  onIntent: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { isMobile, state: sidebarState } = useSidebar();
  const location = useLocation({ select: location => ({ pathname: location.pathname, search: location.searchStr }) });
  const read = useRecentItems(workspaceId, section, open && (isMobile || sidebarState === 'expanded'));
  const base = page.to.replace('$workspaceSlug', slug);
  const sectionActive = location.pathname === base || location.pathname.startsWith(`${base}/`);
  const items = read.state.kind === 'ready' ? read.state.data : [];
  const entries = items.map(item => ({
    ...item,
    link: itemLink(section, slug, item),
    active:
      section === 'workflows'
        ? sectionActive && new URLSearchParams(location.search).get('workflow') === item.id
        : location.pathname === `${base}/${item.id}`,
  }));
  const Icon = page.icon;
  return (
    <SidebarRecentItem
      label={page.label}
      icon={Icon && <Icon size={16} aria-hidden="true" />}
      link={
        <Link
          to={page.to}
          params={{ workspaceSlug: slug }}
          preload={false}
          onPointerEnter={onIntent}
          onFocus={onIntent}
        />
      }
      active={sectionActive && !entries.some(entry => entry.active)}
      entries={entries}
      state={read.state.kind}
      retry={() => void read.refresh()}
      open={open}
      onOpenChange={setOpen}
      refreshing={read.state.kind === 'ready' && read.state.refreshing}
      refreshError={read.state.kind === 'ready' ? read.state.error : null}
    />
  );
}
