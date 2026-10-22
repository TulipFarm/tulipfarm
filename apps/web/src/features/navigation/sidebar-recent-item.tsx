import { useState, type ReactElement, type ReactNode } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import {
  SidebarMenuSkeleton,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSection,
  useSidebar,
} from '@tulipfarm/sprout/sidebar';

export type RecentEntry = { id: string; name: string; link: ReactElement; active: boolean };
export type RecentState = 'loading' | 'ready' | 'error' | 'unavailable';

export function SidebarRecentItem({
  label,
  icon,
  link,
  active,
  entries,
  state,
  retry,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  refreshing = false,
  refreshError,
}: {
  label: string;
  icon: ReactNode;
  link: ReactElement;
  active: boolean;
  entries: RecentEntry[];
  state: RecentState;
  retry: () => void;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  refreshing?: boolean;
  refreshError?: string | null;
}) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const setOpen = (value: boolean) => {
    setLocalOpen(value);
    onOpenChange?.(value);
  };
  const { setOpenMobile, isMobile, state: sidebarState } = useSidebar();
  const visible = open && (isMobile || sidebarState === 'expanded');
  return (
    <SidebarSection
      label={label}
      icon={icon}
      tooltip={label}
      isActive={active}
      aria-current={active ? 'page' : undefined}
      nativeButton={false}
      render={link}
      onClick={() => setOpenMobile(false)}
      open={visible}
      onOpenChange={setOpen}
    >
      {state === 'loading' ? (
        <SidebarMenuSubItem>
          <div role="status" aria-label={`Loading recent ${label.toLowerCase()}`}>
            <span className="sr-only">Loading recent items</span>
            <div aria-hidden="true">
              <SidebarMenuSkeleton />
              <SidebarMenuSkeleton />
              <SidebarMenuSkeleton />
            </div>
          </div>
        </SidebarMenuSubItem>
      ) : state === 'unavailable' ? (
        <SidebarMenuSubItem>
          <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">
            Recent items are unavailable. Open {label.toLowerCase()} to check access.
          </p>
        </SidebarMenuSubItem>
      ) : state === 'error' ? (
        <SidebarMenuSubItem>
          <div className="space-y-1 px-2 py-2">
            <p role="alert" className="text-xs text-sidebar-muted-foreground">
              Could not load recent items.
            </p>
            <Button variant="ghost" size="sm" onClick={retry}>
              Try again
            </Button>
          </div>
        </SidebarMenuSubItem>
      ) : entries.length ? (
        entries.slice(0, 3).map(entry => (
          <SidebarMenuSubItem key={entry.id}>
            <SidebarMenuSubButton
              nativeButton={false}
              render={entry.link}
              isActive={entry.active}
              aria-current={entry.active ? 'page' : undefined}
              title={entry.name}
              onClick={() => setOpenMobile(false)}
            >
              {entry.name}
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        ))
      ) : (
        <SidebarMenuSubItem>
          <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">
            No recent items yet. Open {label.toLowerCase()} to get started.
          </p>
        </SidebarMenuSubItem>
      )}
      {refreshing && (
        <SidebarMenuSubItem>
          <p role="status" className="px-2 text-xs text-sidebar-muted-foreground">
            Updating recent items...
          </p>
        </SidebarMenuSubItem>
      )}
      {refreshError && (
        <SidebarMenuSubItem>
          <div className="space-y-1 px-2 py-2">
            <p role="alert" className="text-xs text-sidebar-muted-foreground">
              Could not update recent items.
            </p>
            <Button variant="ghost" size="sm" disabled={refreshing} aria-busy={refreshing} onClick={retry}>
              Try again
            </Button>
          </div>
        </SidebarMenuSubItem>
      )}
    </SidebarSection>
  );
}
