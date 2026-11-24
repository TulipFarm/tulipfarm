import { useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from '@tulipfarm/icons';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from '@tulipfarm/sprout/sidebar';
import { useLocation } from '@tanstack/react-router';
import { itemLink } from './sidebar-nav-item';
import { useRecentItems, type RecentSection } from './recent-queries';

const defaultVisibleCount = 5;

export function SidebarRecents({
  label,
  section,
  workspaceId,
  slug,
}: {
  label: string;
  section: RecentSection;
  workspaceId: string;
  slug: string;
}) {
  const { isMobile, state, setOpenMobile } = useSidebar();
  const [expanded, setExpanded] = useState(false);
  const visible = isMobile || state === 'expanded';
  const read = useRecentItems(workspaceId, section, visible);
  const pathname = useLocation({ select: location => location.pathname });
  if (!visible) return null;
  const items = read.state.kind === 'ready' ? read.state.data : [];
  if (read.state.kind !== 'loading' && !items.length) return null;
  const base = `/${slug}/${section === 'chat' ? 'chat' : section}`;
  const pinned = items.filter(item => item.pinned);
  const rest = items.filter(item => !item.pinned);
  const activeInHiddenRest = rest.slice(defaultVisibleCount).some(item => pathname === `${base}/${item.id}`);
  const showAll = expanded || activeInHiddenRest;
  const shownRest = showAll ? rest : rest.slice(0, defaultVisibleCount);
  const hiddenCount = rest.length - shownRest.length;
  const row = (item: (typeof items)[number]) => (
    <SidebarMenuItem key={item.id}>
      <SidebarMenuButton
        nativeButton={false}
        render={itemLink(section, slug, item)}
        isActive={pathname === `${base}/${item.id}`}
        aria-current={pathname === `${base}/${item.id}` ? 'page' : undefined}
        title={item.name}
        onClick={() => setOpenMobile(false)}
      >
        <span className="truncate">{item.name}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
  const loading = read.state.kind === 'loading';
  return (
    <>
      {pinned.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel>Pinned</SidebarGroupLabel>
          <SidebarMenu>{pinned.map(row)}</SidebarMenu>
        </SidebarGroup>
      )}
      <SidebarGroup>
        <SidebarGroupLabel>{label}</SidebarGroupLabel>
        <SidebarMenu>
          {loading ? <SidebarMenuSkeleton /> : shownRest.map(row)}
          {!loading && rest.length > defaultVisibleCount && (
            <SidebarMenuItem>
              <SidebarMenuButton
                icon={
                  showAll ? (
                    <ChevronUpIcon size="xs" aria-hidden="true" />
                  ) : (
                    <ChevronDownIcon size="xs" aria-hidden="true" />
                  )
                }
                aria-expanded={showAll}
                onClick={() => setExpanded(open => !open)}
              >
                {showAll ? 'Show fewer' : `Show ${hiddenCount} more`}
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}
