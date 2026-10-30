import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { PackageResource, SystemPackage } from '@tulipfarm/agents/system-package-contracts';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@tulipfarm/sprout/accordion';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tulipfarm/sprout/card';
import { CodeBlock } from '@tulipfarm/sprout/code-block';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { Skeleton, SkeletonGroup } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Table } from '@tulipfarm/sprout/table';
import { RecordList } from '@tulipfarm/sprout/record-list';
import { BookOpen } from 'reicon-react/icons/BookOpen';
import { BranchDown } from 'reicon-react/icons/BranchDown';
import { Database } from 'reicon-react/icons/Database';
import { Files } from 'reicon-react/icons/Files';
import { Plug } from 'reicon-react/icons/Plug';
import { Users } from 'reicon-react/icons/Users';
import { User } from 'reicon-react/icons/User';
import { Code } from 'reicon-react/icons/Code';
import { Clock } from 'reicon-react/icons/Clock';
import { ReadError, ReadFeedback } from '@/components/read-feedback';
import { useFeatureRead } from '@/lib/query';
import { publicPackageRoute } from '@/router';
import { loadPublicPackage, type PublicPackageDetails } from './public-catalog';

const resourceIcons = {
  table: Database,
  'seed-row': Database,
  skill: BookOpen,
  agent: Users,
  workflow: BranchDown,
  integration: Plug,
  file: Files,
};

const inputIcons = {
  team: Users,
  member: User,
  integration: Plug,
  timezone: Clock,
  file: Files,
  asset: Files,
  skill: BookOpen,
  agent: Users,
  connection: Plug,
  'slack-destination': Plug,
  'slack-channel': Plug,
};

const resourceGroups = [
  { kind: 'table', title: 'Tables' },
  { kind: 'seed-row', title: 'Starter records' },
  { kind: 'skill', title: 'Skills' },
  { kind: 'agent', title: 'Agents' },
  { kind: 'workflow', title: 'Workflows' },
  { kind: 'integration', title: 'Integrations' },
  { kind: 'file', title: 'Files' },
] as const;

type PackageTable = Extract<PackageResource, { kind: 'table' }>;
type PackageRow = Extract<PackageResource, { kind: 'seed-row' }>;

function ResourceIcon({ kind }: { kind: PackageResource['kind'] }) {
  const Icon = resourceIcons[kind];
  return <Icon size={18} aria-hidden="true" />;
}

function resourceSummary(resource: PackageResource, document: SystemPackage) {
  switch (resource.kind) {
    case 'table': {
      const rows = document.resources.filter(item => item.kind === 'seed-row' && item.table.key === resource.key);
      return `${resource.fields.length} ${resource.fields.length === 1 ? 'field' : 'fields'} · ${rows.length} starter ${rows.length === 1 ? 'record' : 'records'}`;
    }
    case 'skill':
      return `${resource.files.length} ${resource.files.length === 1 ? 'file' : 'files'}`;
    case 'agent':
      return `${resource.skills.length} ${resource.skills.length === 1 ? 'skill' : 'skills'}`;
    case 'workflow':
      return `${resource.steps.length} ${resource.steps.length === 1 ? 'step' : 'steps'} · ${resource.trigger.kind.replaceAll('-', ' ')} trigger`;
    case 'integration':
      return resource.capabilities.join(', ');
    case 'file':
      return resource.mimeType;
    case 'seed-row':
      return 'Starter record';
  }
}

function resourceTitle(resource: PackageResource) {
  if (resource.kind === 'table') return resource.label;
  if (resource.kind === 'agent') return resource.definition.name;
  if (resource.kind === 'workflow' || resource.kind === 'file') return resource.name;
  if (resource.kind === 'seed-row') {
    const value = Object.values(resource.values).find(value => value?.kind === 'text');
    if (value?.kind === 'text') return value.value;
  }
  return resource.key.replaceAll('-', ' ');
}

export function PublicPackagePage() {
  const { workspaceSlug, packageName, packageVersion } = publicPackageRoute.useParams();
  const read = useFeatureRead({
    key: ['public-package', packageName, packageVersion],
    load: signal => loadPublicPackage(packageName, packageVersion, signal),
    staleTime: 5 * 60_000,
  });
  const details = read.state.kind === 'ready' ? read.state.data : null;
  const retry = (
    <Button variant="outline" onClick={() => void read.refresh()}>
      Retry package
    </Button>
  );
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          title={details?.document.package.title ?? 'Package'}
          parent={{ label: 'Packages', link: <Link to="/$workspaceSlug/packages" params={{ workspaceSlug }} /> }}
        />
        <ReadFeedback
          state={read.state}
          errorTitle="Could not load package"
          retry={retry}
          loading={
            <SkeletonGroup label="Loading package details">
              <Skeleton shape="title" />
              <Skeleton />
              <Skeleton shape="panel" />
            </SkeletonGroup>
          }
          unavailable={() => (
            <StatePanel
              kind="unavailable"
              title="Package unavailable"
              description="This package version is not available. Return to Packages to choose another."
            >
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link to="/$workspaceSlug/packages" params={{ workspaceSlug }} />}
              >
                Browse packages
              </Button>
            </StatePanel>
          )}
          refreshError={message => (
            <ReadError message={`Showing the last loaded package. ${message}`}>{retry}</ReadError>
          )}
        >
          {data => (
            <PackageDetails
              details={data}
              install={
                <Button
                  size="lg"
                  disabled={read.state.kind !== 'ready' || !!read.state.error}
                  nativeButton={false}
                  render={
                    <Link
                      to="/$workspaceSlug"
                      params={{ workspaceSlug }}
                      search={{ intent: 'install-package', packageName, packageVersion }}
                    />
                  }
                >
                  Install
                </Button>
              }
            />
          )}
        </ReadFeedback>
      </PageContent>
    </div>
  );
}

function PackageDetails({ details, install }: { details: PublicPackageDetails; install: ReactNode }) {
  const { entry, document, source } = details;
  return (
    <div className="grid items-start gap-8 lg:grid-cols-3 lg:gap-x-6">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <div className="flex items-center gap-3">
          <Files size={24} aria-hidden="true" />
          <p className="min-w-0 break-words text-2xl font-medium">{document.package.title}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{entry.category}</Badge>
          <Badge variant="outline">v{document.package.version}</Badge>
          <Badge variant="outline">{document.package.license} license</Badge>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{document.package.description}</p>
      </div>
      <aside aria-label="Package installation" className="min-w-0 lg:col-start-3 lg:row-span-3 lg:row-start-1">
        <Card>
          <CardHeader>
            <div className="grid">{install}</div>
          </CardHeader>
          <CardContent>
            <div className="space-y-5">
              <CardTitle render={<h2 />}>Before installing</CardTitle>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Install opens a new chat and sends your package request. Review and approve the installation in chat.
              </p>
              {document.inputs.length ? (
                <dl className="space-y-3">
                  {document.inputs.map(input => {
                    const Icon = inputIcons[input.kind];
                    return (
                      <div key={input.key} className="flex flex-wrap items-center justify-between gap-2">
                        <dt className="flex min-w-0 items-center gap-2 text-sm">
                          <Icon size={16} aria-hidden="true" />
                          <span className="break-words">{input.title}</span>
                        </dt>
                        <dd>
                          <Badge variant="secondary" size="chip">
                            {input.kind.replaceAll('-', ' ')}
                          </Badge>
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">No workspace inputs required.</p>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                Choose workspace inputs and review permissions in chat before any changes are made.
              </p>
            </div>
          </CardContent>
        </Card>
      </aside>
      <section aria-labelledby="package-contents-heading" className="min-w-0 lg:col-span-2">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-3">
              <CardTitle render={<h2 id="package-contents-heading" />}>What’s included</CardTitle>
              <Badge variant="secondary">{document.resources.length} resources</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <Accordion multiple>
              {resourceGroups.map(group => {
                const resources = document.resources.filter(
                  resource =>
                    resource.kind === group.kind &&
                    (resource.kind !== 'seed-row' ||
                      !document.resources.some(table => table.kind === 'table' && table.key === resource.table.key)),
                );
                if (!resources.length) return null;
                return (
                  <AccordionItem key={group.kind} value={group.kind}>
                    <AccordionTrigger>
                      <span className="flex min-w-0 items-center gap-3">
                        <ResourceIcon kind={group.kind} />
                        <span>{group.title}</span>
                        <Badge variant="secondary" size="chip">
                          {resources.length}
                        </Badge>
                      </span>
                    </AccordionTrigger>
                    <AccordionContent>
                      <Accordion multiple>
                        {resources.map(resource => (
                          <AccordionItem key={resource.key} value={resource.key}>
                            <AccordionTrigger variant="quiet">
                              <div className="flex min-w-0 flex-1 items-start gap-3 text-left">
                                <span className="mt-0.5 shrink-0 text-muted-foreground">
                                  <ResourceIcon kind={resource.kind} />
                                </span>
                                <div className="min-w-0 space-y-2">
                                  <span className="block break-words font-medium">{resourceTitle(resource)}</span>
                                  <span className="block text-xs font-normal text-muted-foreground">
                                    {resourceSummary(resource, document)}
                                  </span>
                                </div>
                              </div>
                            </AccordionTrigger>
                            <AccordionContent>
                              <div className="space-y-4">
                                {'requestedState' in resource && (
                                  <Badge variant="outline" size="chip">
                                    Requested: {resource.requestedState}
                                  </Badge>
                                )}
                                <ResourceDetails resource={resource} document={document} />
                              </div>
                            </AccordionContent>
                          </AccordionItem>
                        ))}
                      </Accordion>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          </CardContent>
        </Card>
      </section>
      <div className="min-w-0 lg:col-span-2">
        <Accordion multiple>
          <AccordionItem value="technical-details">
            <AccordionTrigger>Technical details</AccordionTrigger>
            <AccordionContent>
              <div className="grid gap-8 py-4 sm:grid-cols-2">
                <section className="space-y-3">
                  <h2 className="text-sm font-medium">Required capabilities</h2>
                  <ul className="flex flex-wrap gap-2">
                    {document.requires.capabilities.map(capability => (
                      <li key={capability}>
                        <Badge variant="secondary">{capability.replaceAll('-', ' ')}</Badge>
                      </li>
                    ))}
                  </ul>
                </section>
                {document.outputs.length > 0 && (
                  <section className="space-y-3">
                    <h2 className="text-sm font-medium">Declared outputs</h2>
                    <ul className="space-y-3 text-sm text-muted-foreground">
                      {document.outputs.map(output => {
                        const resource = document.resources.find(resource => resource.key === output.resource.key);
                        return (
                          <li key={output.key} className="flex items-start gap-2">
                            {resource && (
                              <span className="shrink-0">
                                <ResourceIcon kind={resource.kind} />
                              </span>
                            )}
                            <span className="min-w-0 break-words">
                              {resource ? resourceTitle(resource) : output.key}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="definition">
            <AccordionTrigger>
              <span className="flex items-center gap-2">
                <Code size={18} aria-hidden="true" />
                Full package definition
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <p className="mb-3 text-sm text-muted-foreground">
                The versioned definition includes every resource, permission, file and requested state. Reading it does
                not execute it.
              </p>
              <CodeBlock code={source} language="json" filename="package.json" />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  );
}

function ResourceDetails({ resource, document }: { resource: PackageResource; document: SystemPackage }) {
  if (resource.kind === 'table')
    return (
      <div className="space-y-5">
        <Table
          aria-label={`${resource.label} fields`}
          data={resource.fields}
          getRowId={field => field.key}
          columns={[
            {
              key: 'label',
              header: 'Field',
              width: 240,
              cell: field => <span className="whitespace-normal break-words font-medium">{field.label}</span>,
            },
            {
              key: 'kind',
              header: 'Type',
              width: 144,
              cell: field => (
                <Badge variant="secondary" size="chip">
                  {field.kind.replaceAll('-', ' ')}
                </Badge>
              ),
            },
            {
              key: 'required',
              header: 'Rules',
              width: 240,
              cell: field => (
                <div className="flex flex-wrap gap-1">
                  {field.required && (
                    <Badge variant="outline" size="chip">
                      Required
                    </Badge>
                  )}
                  {'options' in field &&
                    field.options.map(option => (
                      <Badge key={option.key} variant="secondary" size="chip">
                        {option.label}
                        {option.retired ? ' (retired)' : ''}
                      </Badge>
                    ))}
                  {field.kind === 'relationship' && (
                    <span className="whitespace-normal text-xs">
                      {document.resources.find(
                        (item): item is PackageTable => item.key === field.target.key && item.kind === 'table',
                      )?.label ?? field.target.key}
                    </span>
                  )}
                  {!field.required && !('options' in field) && field.kind !== 'relationship' && (
                    <span className="text-xs text-muted-foreground">Optional</span>
                  )}
                </div>
              ),
            },
          ]}
        />
        <StarterRecords table={resource} document={document} />
      </div>
    );
  if (resource.kind === 'agent')
    return (
      <div className="space-y-4">
        {resource.skills.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {resource.skills.map((skill, index) => {
              const linked =
                skill.kind === 'resource'
                  ? document.resources.find(item => item.kind === 'skill' && item.key === skill.key)
                  : null;
              return (
                <Badge key={index} variant="secondary">
                  <BookOpen size={14} aria-hidden="true" />
                  {linked
                    ? resourceTitle(linked)
                    : skill.kind === 'input'
                      ? (document.inputs.find(input => input.key === skill.key)?.title ?? skill.key)
                      : skill.kind === 'resource'
                        ? skill.key
                        : 'Built-in skill'}
                </Badge>
              );
            })}
          </div>
        )}
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Instructions</h4>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{resource.definition.instructions}</p>
        </div>
      </div>
    );
  if (resource.kind === 'skill')
    return (
      <div className="space-y-4">
        {resource.files.map(file => {
          const asset = document.assets.find(asset => asset.key === file.asset);
          return (
            <div key={file.path}>
              {asset?.encoding === 'utf8' ? (
                <CodeBlock code={asset.content} filename={file.path} wrap />
              ) : (
                <p className="text-sm">
                  {file.path}
                  {asset ? ` · ${asset.size} bytes` : ' · Content unavailable'}
                </p>
              )}
            </div>
          );
        })}
      </div>
    );
  if (resource.kind === 'workflow')
    return (
      <div className="space-y-3">
        <Badge variant="secondary">Trigger: {resource.trigger.kind.replaceAll('-', ' ')}</Badge>
        <RecordList
          label={`${resource.name} steps`}
          density="sm"
          items={resource.steps.map((step, index) => ({
            id: step.id,
            title: step.id.replaceAll('_', ' '),
            kind: step.kind,
            order: index + 1,
          }))}
          renderTitle={step => (
            <span className="flex items-center gap-2">
              <span className="text-xs tabular-nums text-muted-foreground">{step.order}</span>
              {step.title}
            </span>
          )}
          badges={step => (
            <Badge variant="outline" size="chip">
              {step.kind.replaceAll('-', ' ')}
            </Badge>
          )}
        />
      </div>
    );
  if (resource.kind === 'file') {
    const asset = document.assets.find(asset => asset.key === resource.asset);
    if (asset?.encoding === 'utf8') return <CodeBlock code={asset.content} filename={resource.name} wrap />;
  }
  return <CodeBlock code={JSON.stringify(resource, null, 2)} language="json" filename={`${resource.key}.json`} />;
}

function StarterRecords({ table, document }: { table: PackageTable; document: SystemPackage }) {
  const records = document.resources.filter(
    (resource): resource is PackageRow => resource.kind === 'seed-row' && resource.table.key === table.key,
  );
  if (!records.length) return null;
  const rows: Record<string, string>[] = records.map(record => ({
    ...Object.fromEntries(
      table.fields.map(field => [`field:${field.key}`, packageCell(record.values[field.key], field, document)]),
    ),
    id: record.key,
  }));
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-medium">Starter records</h4>
        <Badge variant="secondary" size="chip">
          {records.length}
        </Badge>
      </div>
      <Table
        aria-label={`${table.label} starter records`}
        data={rows}
        getRowId={row => row.id!}
        columns={table.fields.map(field => ({
          key: `field:${field.key}`,
          header: field.label,
          width: field.kind === 'numeric' ? 160 : 240,
          align: field.kind === 'numeric' ? ('right' as const) : ('left' as const),
          cell: (row: Record<string, string>) => (
            <span className="whitespace-normal break-words">{row[`field:${field.key}`]}</span>
          ),
        }))}
      />
    </div>
  );
}

function packageCell(
  value: PackageRow['values'][string] | undefined,
  field: PackageTable['fields'][number],
  document: SystemPackage,
): string {
  if (value == null) return 'Not set';
  if ('value' in value) return typeof value.value === 'boolean' ? (value.value ? 'Yes' : 'No') : value.value;
  const label = (key: string) =>
    'options' in field ? (field.options.find(option => option.key === key)?.label ?? key) : key;
  if (value.kind === 'single-select') return label(value.option);
  if (value.kind === 'multi-select') return value.options.map(label).join(', ') || 'None';
  const references = value.kind === 'relationship' ? value.rows : value.files;
  return (
    references
      .map(reference => {
        const resource = reference.kind === 'resource' && document.resources.find(item => item.key === reference.key);
        return resource
          ? resourceTitle(resource)
          : (document.inputs.find(input => input.key === reference.key)?.title ?? reference.key);
      })
      .join(', ') || 'None'
  );
}
