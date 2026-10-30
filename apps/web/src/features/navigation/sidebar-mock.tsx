import { useEffect, useState } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import type { Page } from '@/pages/workspace';
import { Button } from '@tulipfarm/sprout/button';
import { Label } from '@tulipfarm/sprout/label';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@tulipfarm/sprout/sidebar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { SidebarRecentItem, type RecentState } from './sidebar-recent-item';

const samples: Record<string, readonly string[]> = {
  Chats: ['Plan next week', 'Review customer feedback', 'October sales summary', 'Earlier conversation'],
  Projects: ['Autumn launch', 'Customer onboarding', 'Team operations', 'Earlier project'],
  Agents: ['Research assistant', 'Customer success', 'Operations lead', 'Earlier agent'],
  'My agent tasks': [
    'Prepare the weekly report',
    'Review open support tickets',
    'Find overdue invoices',
    'Earlier task',
  ],
  Workflows: ['Weekly team digest', 'New customer welcome', 'Invoice reminders', 'Earlier workflow'],
  Tables: ['Customers', 'Sales pipeline', 'Team directory', 'Earlier table'],
  Files: ['Launch brief.pdf', 'Customer feedback.csv', 'Brand guidelines.pdf', 'Earlier file.pdf'],
};
const idFor = (index: number) => `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`;
const scenarioLabels: Record<string, string> = {
  ready: 'Three recent items',
  slow: 'Loading',
  empty: 'Empty',
  error: 'Error and retry',
  long: 'Long names',
};
function useMockLocation() {
  return useLocation({
    select: location => ({
      pathname: location.pathname,
      scenario: new URLSearchParams(location.searchStr).get('scenario') ?? 'ready',
    }),
  });
}

export function SidebarMockNavItem({ page }: { page: Page }) {
  const location = useMockLocation();
  const base = page.to.replace('$workspaceSlug', 'sidebar-mock');
  const names = samples[page.label];
  const [state, setState] = useState<RecentState>(
    location.scenario === 'slow' ? 'loading' : location.scenario === 'error' ? 'error' : 'ready',
  );
  useEffect(() => {
    if (location.scenario !== 'slow') return;
    const timer = window.setTimeout(() => setState('ready'), 2500);
    return () => window.clearTimeout(timer);
  }, [location.scenario]);
  const { setOpenMobile } = useSidebar();
  const Icon = page.icon;
  const icon = Icon && <Icon size={16} aria-hidden="true" />;
  const active = location.pathname === base || (page.label !== 'New chat' && location.pathname.startsWith(`${base}/`));
  const link = <Link to={page.to} params={{ workspaceSlug: 'sidebar-mock' }} preload={false} />;
  if (!names)
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          icon={icon}
          tooltip={page.label}
          isActive={active}
          aria-current={active ? 'page' : undefined}
          nativeButton={false}
          render={link}
          onClick={() => setOpenMobile(false)}
        >
          {page.label}
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  const entries = (location.scenario === 'empty' ? [] : names).map((name, index) => {
    const id = idFor(index);
    const href = `${base}/${id}`;
    return {
      id,
      name:
        location.scenario === 'long' && index === 0 ? `${name}: a long item name that should stay on one line` : name,
      link: <Link to={href} preload={false} />,
      active: location.pathname === href,
    };
  });
  return (
    <SidebarRecentItem
      label={page.label}
      icon={icon}
      link={link}
      active={active && !entries.some(entry => entry.active)}
      entries={entries}
      state={state}
      defaultOpen
      retry={() => setState('ready')}
    />
  );
}

export function SidebarMockPage() {
  const location = useMockLocation();
  const segment = location.pathname.split('/')[2] ?? '';
  const labels: Record<string, string> = {
    chat: 'Chats',
    projects: 'Projects',
    agents: 'Agents',
    'agent-tasks': 'My agent tasks',
    workflows: 'Workflows',
    tables: 'Tables',
    files: 'Files',
    skills: 'Skills',
    integrations: 'Integrations',
  };
  const label = labels[segment] ?? 'New chat';
  const selected = location.pathname.split('/')[3];
  const index = [0, 1, 2].find(index => idFor(index) === selected);
  const name = index === undefined ? null : samples[label]?.[index];
  const backHref = `/sidebar-mock/${segment}`;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader title={name ?? label} description="Local sidebar mock. Sample data only; nothing is saved." />
        <section className="max-w-xl space-y-5 py-8" aria-label="Sidebar mock">
          <h2 className="text-xl font-medium">{name ? `Opened ${name}` : 'Your recent work, one click away'}</h2>
          <p className="text-base text-muted-foreground">
            Use the arrows to open or close each section. Select a name to open an item, or select the section title to
            see its page.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Label htmlFor="sidebar-scenario">Mock state</Label>
            <Select
              value={location.scenario}
              onValueChange={value => {
                if (value) window.location.assign(`/sidebar-mock/chat?scenario=${value}`);
              }}
            >
              <SelectTrigger id="sidebar-scenario">
                <SelectValue>{scenarioLabels[location.scenario]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ready">Three recent items</SelectItem>
                <SelectItem value="slow">Loading</SelectItem>
                <SelectItem value="empty">Empty</SelectItem>
                <SelectItem value="error">Error and retry</SelectItem>
                <SelectItem value="long">Long names</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-sm text-muted-foreground">
            Skills and Integrations remain plain links. The lists are sample shortcuts, not live workspace data.
          </p>
          {name && (
            <Button variant="outline" nativeButton={false} render={<Link to={backHref} />}>
              Back to {label.toLowerCase()}
            </Button>
          )}
        </section>
      </PageContent>
    </div>
  );
}
