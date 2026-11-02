import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import leaveManagement from '@tulipfarm/config/examples/system-packages/leave-management.json';
import { systemPackageSchema } from '@tulipfarm/agents/system-package-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Card, CardContent, CardHeader } from '@tulipfarm/sprout/card';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Skeleton, SkeletonGroup } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { ArrowRight } from 'reicon-react/icons/ArrowRight';
import { Box } from 'reicon-react/icons/Box';
import { Building2 } from 'reicon-react/icons/Building2';
import { Bullhorn } from 'reicon-react/icons/Bullhorn';
import { ChartLine } from 'reicon-react/icons/ChartLine';
import { Code } from 'reicon-react/icons/Code';
import { Gear } from 'reicon-react/icons/Gear';
import { Grid } from 'reicon-react/icons/Grid';
import { Handshake } from 'reicon-react/icons/Handshake';
import { Headphones } from 'reicon-react/icons/Headphones';
import { Scale } from 'reicon-react/icons/Scale';
import { ShieldCheck } from 'reicon-react/icons/ShieldCheck';
import { Users } from 'reicon-react/icons/Users';
import { Wallet } from 'reicon-react/icons/Wallet';
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
      <div className="space-y-6" aria-hidden="true">
        <div className="max-w-xl">
          <Skeleton />
        </div>
        <div className="grid auto-rows-fr gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Card key={index}>
              <CardContent>
                <div className="flex items-center gap-3">
                  <Skeleton shape="checkbox" />
                  <Skeleton />
                </div>
              </CardContent>
              <CardHeader>
                <Skeleton shape="title" />
                <Skeleton />
              </CardHeader>
            </Card>
          ))}
        </div>
      </div>
    </SkeletonGroup>
  );
}

type CategoryStyle = { icon: typeof Box; tile: string };

const categoryStyles: Record<string, CategoryStyle> = {
  'Agency & client services': {
    icon: Handshake,
    tile: 'bg-[color-mix(in_oklab,var(--sprout-purple)_14%,transparent)] text-(--sprout-purple)',
  },
  Finance: { icon: Wallet, tile: 'bg-[color-mix(in_oklab,var(--sprout-green)_14%,transparent)] text-(--sprout-green)' },
  'IT & security': {
    icon: ShieldCheck,
    tile: 'bg-[color-mix(in_oklab,var(--sprout-blue)_14%,transparent)] text-(--sprout-blue)',
  },
  Industry: {
    icon: Building2,
    tile: 'bg-[color-mix(in_oklab,var(--sprout-orange)_14%,transparent)] text-(--sprout-orange)',
  },
  'Legal & compliance': {
    icon: Scale,
    tile: 'bg-[color-mix(in_oklab,var(--sprout-teal)_14%,transparent)] text-(--sprout-teal)',
  },
  Marketing: { icon: Bullhorn, tile: 'bg-[color-mix(in_oklab,var(--sprout-red)_14%,transparent)] text-(--sprout-red)' },
  Operations: {
    icon: Gear,
    tile: 'bg-[color-mix(in_oklab,var(--sprout-yellow)_18%,transparent)] text-(--sprout-yellow)',
  },
  'People & HR': {
    icon: Users,
    tile: 'bg-[color-mix(in_oklab,var(--sprout-primary)_14%,transparent)] text-(--sprout-primary)',
  },
  'Product & engineering': {
    icon: Code,
    tile: 'bg-[color-mix(in_oklab,var(--sprout-blue)_14%,transparent)] text-(--sprout-blue)',
  },
  Sales: {
    icon: ChartLine,
    tile: 'bg-[color-mix(in_oklab,var(--sprout-green)_14%,transparent)] text-(--sprout-green)',
  },
  'Support & success': {
    icon: Headphones,
    tile: 'bg-[color-mix(in_oklab,var(--sprout-teal)_14%,transparent)] text-(--sprout-teal)',
  },
};
const fallbackStyle: CategoryStyle = { icon: Box, tile: 'bg-muted text-muted-foreground' };
const categoryStyle = (category: string) => categoryStyles[category] ?? fallbackStyle;

const popularPackages = [
  'project-tracking',
  'sales-crm',
  'support-desk',
  'leave-management',
  'marketing-content',
  'product-backlog',
];
const sectionSize = 6;

function PublicPackageBrowser({ packages }: { packages: PublicPackage[] }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const counts = new Map<string, number>();
  for (const entry of packages) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  const categories = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const needle = query.trim().toLocaleLowerCase();
  const filtering = needle !== '' || category !== 'all';
  const filtered = packages.filter(
    entry =>
      (category === 'all' || category === entry.category) &&
      [entry.title, entry.description, entry.category, ...entry.tags].join(' ').toLocaleLowerCase().includes(needle),
  );
  const popular = popularPackages.flatMap(name => packages.find(entry => entry.name === name) ?? []);
  const reset = () => {
    setQuery('');
    setCategory('all');
  };
  const choose = (value: string[]) => {
    if (value[0]) setCategory(value[0]);
  };
  const categoryItems = (layout: 'rail' | 'chips') => [
    <ToggleGroupItem key="all" value="all">
      <CategoryLabel layout={layout} icon={Grid} label="All packages" count={packages.length} />
    </ToggleGroupItem>,
    ...categories.map(value => (
      <ToggleGroupItem key={value} value={value}>
        <CategoryLabel layout={layout} icon={categoryStyle(value).icon} label={value} count={counts.get(value) ?? 0} />
      </ToggleGroupItem>
    )),
  ];
  return (
    <section aria-label="Package marketplace" className="flex flex-col gap-8 lg:flex-row lg:items-start">
      <nav aria-label="Package categories" className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-4 space-y-2">
          <h2 className="px-2 text-xs font-medium tracking-wide text-muted-foreground">Categories</h2>
          <ToggleGroup
            aria-label="Filter by category"
            orientation="vertical"
            spacing={1}
            value={[category]}
            onValueChange={choose}
          >
            {categoryItems('rail')}
          </ToggleGroup>
        </div>
      </nav>
      <div className="min-w-0 flex-1 space-y-8">
        <div className="space-y-3">
          <div className="max-w-xl">
            <SearchField
              label="Search packages"
              placeholder="Search by name, use or tag"
              value={query}
              onChange={setQuery}
              maxLength={120}
            />
          </div>
          <div className="-mx-1 overflow-x-auto px-1 pb-1 lg:hidden">
            <ToggleGroup
              aria-label="Filter by category"
              variant="outline"
              size="sm"
              value={[category]}
              onValueChange={choose}
            >
              {categoryItems('chips')}
            </ToggleGroup>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <p role="status" aria-live="polite">
              {filtering
                ? `${filtered.length} of ${packages.length} ${packages.length === 1 ? 'package' : 'packages'}`
                : `${packages.length} ${packages.length === 1 ? 'package' : 'packages'} across ${categories.length} categories`}
            </p>
            {filtering ? (
              <Button variant="ghost" size="sm" onClick={reset}>
                Clear filters
              </Button>
            ) : (
              <p>Browsing won’t install anything.</p>
            )}
          </div>
        </div>
        {filtering ? (
          filtered.length ? (
            <PackageShelf
              title={category === 'all' ? 'Results' : category}
              description={needle ? `Matching “${query.trim()}”` : undefined}
              icon={category === 'all' ? undefined : categoryStyle(category)}
              packages={filtered}
            />
          ) : (
            <StatePanel
              kind="empty"
              icon={Box}
              title="No packages match your filters"
              description="Try another search or browse every category."
            >
              <Button variant="outline" onClick={reset}>
                Show all packages
              </Button>
            </StatePanel>
          )
        ) : packages.length ? (
          <>
            {popular.length > 0 && (
              <PackageShelf
                title="Popular"
                description="Good first systems for most teams."
                packages={popular}
                featured
              />
            )}
            {categories.map(value => {
              const entries = packages.filter(entry => entry.category === value);
              return (
                <PackageShelf
                  key={value}
                  title={value}
                  icon={categoryStyle(value)}
                  packages={entries.slice(0, sectionSize)}
                  more={
                    entries.length > sectionSize && (
                      <Button variant="ghost" size="sm" onClick={() => setCategory(value)}>
                        See all {entries.length}
                        <ArrowRight data-icon="inline-end" aria-hidden="true" />
                      </Button>
                    )
                  }
                />
              );
            })}
          </>
        ) : (
          <StatePanel
            kind="empty"
            icon={Box}
            title="No public packages yet"
            description="Check back for new systems from the public catalog."
          />
        )}
      </div>
    </section>
  );
}

function CategoryLabel({
  layout,
  icon: Icon,
  label,
  count,
}: {
  layout: 'rail' | 'chips';
  icon: typeof Box;
  label: string;
  count: number;
}) {
  return (
    <span className={layout === 'rail' ? 'flex w-full items-center gap-2 text-left' : 'flex items-center gap-1.5'}>
      <Icon size={16} aria-hidden="true" />
      <span className={layout === 'rail' ? 'min-w-0 flex-1 truncate' : undefined}>{label}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
    </span>
  );
}

function PackageShelf({
  title,
  description,
  icon,
  packages,
  more,
  featured = false,
}: {
  title: string;
  description?: string | undefined;
  icon?: CategoryStyle | undefined;
  packages: PublicPackage[];
  more?: ReactNode;
  featured?: boolean;
}) {
  const Icon = icon?.icon;
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon && (
            <span className={`flex size-7 shrink-0 items-center justify-center rounded-md ${icon.tile}`}>
              <Icon size={15} aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight text-balance">{title}</h2>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
        </div>
        {more}
      </div>
      <ul className="grid auto-rows-fr gap-3 sm:grid-cols-2 2xl:grid-cols-3">
        {packages.map(entry => (
          <li
            key={`${entry.name}/${entry.version}`}
            className="grid min-w-0 rounded-(--sprout-radius-panel) outline-offset-4 transition duration-200 ease-out focus-within:outline-2 focus-within:outline-ring hover:-translate-y-0.5 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0"
          >
            <PublicPackageCard entry={entry} featured={featured} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PublicPackageCard({ entry, featured }: { entry: PublicPackage; featured: boolean }) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const { icon: Icon, tile } = categoryStyle(entry.category);
  return (
    <Card
      surface={featured ? 'raised' : 'default'}
      render={
        <Link
          to="/$workspaceSlug/packages/catalog/$packageName/$packageVersion"
          params={{ workspaceSlug, packageName: entry.name, packageVersion: entry.version }}
        />
      }
    >
      <CardContent>
        <div className="flex items-start gap-3">
          <span className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${tile}`}>
            <Icon size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-sm font-semibold leading-5 text-balance">{entry.title}</h3>
            <p title={entry.description} className="line-clamp-2 text-xs leading-5 text-muted-foreground">
              {entry.description}
            </p>
          </div>
        </div>
      </CardContent>
      <div className="mt-auto flex items-center justify-between gap-2 px-4 text-xs text-muted-foreground">
        <span className="truncate">{entry.category}</span>
        <span className="shrink-0 tabular-nums">v{entry.version}</span>
      </div>
    </Card>
  );
}
