import { useState } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import leaveManagement from '@tulipfarm/config/examples/system-packages/leave-management.json';
import { systemPackageSchema } from '@tulipfarm/agents/system-package-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tulipfarm/sprout/card';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Skeleton, SkeletonGroup } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Box } from 'reicon-react/icons/Box';
import { Calendar } from 'reicon-react/icons/Calendar';
import { Briefcase } from 'reicon-react/icons/Briefcase';
import { Flag } from 'reicon-react/icons/Flag';
import { Headphones } from 'reicon-react/icons/Headphones';
import { Layers } from 'reicon-react/icons/Layers';
import { Pen } from 'reicon-react/icons/Pen';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import type { ReadState } from '@/features/tables/request-state';
import { useFeatureRead } from '@/lib/query';
import { workspaceRoute } from '@/router';
import { loadPublicPackages, type PublicPackage } from './public-catalog';

export const bundledPackage = systemPackageSchema.parse(leaveManagement);

export function SystemPackagesPage() {
  const navigate = useNavigate();
  const search = useLocation({ select: location => location.searchStr });
  const forcedState = import.meta.env.DEV ? new URLSearchParams(search).get('state') : null;
  const isForced = forcedState === 'loading' || forcedState === 'error';
  const read = useFeatureRead({
    key: ['public-packages'],
    load: loadPublicPackages,
    staleTime: 5 * 60_000,
    enabled: !isForced,
  });
  const state: ReadState<PublicPackage[]> =
    forcedState === 'loading'
      ? { kind: 'loading' }
      : forcedState === 'error'
        ? { kind: 'error', message: 'The request could not be completed. Check your connection and try again.' }
        : read.state;
  const retry = (
    <Button
      variant="outline"
      onClick={() => {
        if (isForced) void navigate({ to: '.', search: {}, replace: true });
        else void read.refresh();
      }}
    >
      Retry catalog
    </Button>
  );
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          title="Packages"
          description="Ready-to-use starting points for your team’s tables, skills, agents and workflows."
        />
        <ReadFeedback
          state={state}
          errorTitle="Could not load packages"
          retry={retry}
          loading={<PackageCatalogSkeleton />}
          unavailable={() => (
            <StatePanel kind="unavailable" title="Packages unavailable" description="Refresh the catalog to try again.">
              {retry}
            </StatePanel>
          )}
          refreshError={message => (
            <ReadError message={`Showing the last loaded catalog. ${message}`}>{retry}</ReadError>
          )}
          refreshing={<p role="status">Refreshing packages…</p>}
        >
          {packages => <PublicPackageBrowser packages={packages} />}
        </ReadFeedback>
      </PageContent>
    </div>
  );
}

function PackageCatalogSkeleton() {
  return (
    <SkeletonGroup label="Loading packages">
      <div className="grid auto-rows-fr gap-4 md:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <Card key={index}>
            <CardContent>
              <div className="flex h-5 items-center">
                <Skeleton shape="checkbox" />
              </div>
            </CardContent>
            <CardHeader>
              <Skeleton shape="title" />
              <Skeleton />
            </CardHeader>
          </Card>
        ))}
      </div>
    </SkeletonGroup>
  );
}

function PublicPackageBrowser({ packages }: { packages: PublicPackage[] }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const categories = [...new Set(packages.map(entry => entry.category))].sort();
  const needle = query.trim().toLocaleLowerCase();
  const filtered = packages.filter(
    entry =>
      (category === 'all' || category === entry.category) &&
      [entry.title, entry.description, entry.category, ...entry.tags].join(' ').toLocaleLowerCase().includes(needle),
  );
  const reset = () => {
    setQuery('');
    setCategory('all');
  };
  return (
    <section aria-label="Public packages" className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full sm:max-w-sm">
          <SearchField
            label="Search packages"
            placeholder="Search packages"
            value={query}
            onChange={setQuery}
            maxLength={120}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select value={category} onValueChange={value => setCategory(value ?? 'all')}>
            <SelectTrigger aria-label="Filter by category">
              <SelectValue>{category === 'all' ? 'All categories' : category}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map(value => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(needle || category !== 'all') && (
            <Button variant="ghost" onClick={reset}>
              Clear filters
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <p role="status" aria-live="polite">
          {filtered.length} {filtered.length === 1 ? 'package' : 'packages'}
          {filtered.length !== packages.length ? ` of ${packages.length}` : ''}
        </p>
        <p>Explore what’s included. Browsing won’t install anything.</p>
      </div>
      {filtered.length ? (
        <ul className="grid auto-rows-fr gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map(entry => (
            <li
              key={`${entry.name}/${entry.version}`}
              className="grid min-w-0 rounded-xl outline-offset-4 focus-within:outline-2 focus-within:outline-ring"
            >
              <PublicPackageCard entry={entry} />
            </li>
          ))}
        </ul>
      ) : (
        <StatePanel
          kind="empty"
          icon={Box}
          title={packages.length ? 'No packages match your filters' : 'No public packages yet'}
          description={
            packages.length
              ? 'Try another search or browse every category.'
              : 'Check back for new systems from the public catalog.'
          }
        >
          {packages.length > 0 && (
            <Button variant="outline" onClick={reset}>
              Show all packages
            </Button>
          )}
        </StatePanel>
      )}
    </section>
  );
}

const packageIcons: Record<string, { icon: typeof Box; color: string }> = {
  'leave-management': { icon: Calendar, color: 'text-(--sprout-green)' },
  'marketing-content': { icon: Pen, color: 'text-(--sprout-orange)' },
  'product-backlog': { icon: Layers, color: 'text-(--sprout-purple)' },
  'project-tracking': { icon: Flag, color: 'text-(--sprout-primary)' },
  'sales-crm': { icon: Briefcase, color: 'text-(--sprout-blue)' },
  'support-desk': { icon: Headphones, color: 'text-(--sprout-yellow)' },
};

function PublicPackageCard({ entry }: { entry: PublicPackage }) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const { icon: Icon, color } = packageIcons[entry.name] ?? { icon: Box, color: 'text-muted-foreground' };
  return (
    <Card
      render={
        <Link
          to="/$workspaceSlug/packages/catalog/$packageName/$packageVersion"
          params={{ workspaceSlug, packageName: entry.name, packageVersion: entry.version }}
        />
      }
    >
      <CardContent>
        <div className={color}>
          <Icon size={20} aria-hidden="true" />
        </div>
      </CardContent>
      <CardHeader>
        <CardTitle render={<h2 />}>{entry.title}</CardTitle>
        <p title={entry.description} className="truncate text-xs leading-5 text-muted-foreground">
          {entry.description}
        </p>
      </CardHeader>
    </Card>
  );
}
