import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton, useSidebar } from '@tulipfarm/sprout/sidebar';
import { useLocation } from '@tanstack/react-router';
import { itemLink } from './sidebar-nav-item';
import { useRecentItems, type RecentSection } from './recent-queries';

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
  const visible = isMobile || state === 'expanded';
  const read = useRecentItems(workspaceId, section, visible);
  const pathname = useLocation({ select: location => location.pathname });
  if (!visible) return null;
  const items = read.state.kind === 'ready' ? read.state.data : [];
  if (read.state.kind !== 'loading' && !items.length) return null;
  const base = `/${slug}/${section === 'chat' ? 'chat' : section}`;
  const pinned = items.filter(item => item.pinned);
  const rest = items.filter(item => !item.pinned);
  const row = (item: (typeof items)[number]) => (
    <SidebarMenuItem key={item.id}>
      <SidebarMenuButton
        nativeButton={false}
        render={itemLink(section, slug, item)}
        isActive={pathname === `${base}/${item.id}`}
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
        <SidebarMenu>{loading ? <SidebarMenuSkeleton /> : rest.map(row)}</SidebarMenu>
      </SidebarGroup>
    </>
  );
}
