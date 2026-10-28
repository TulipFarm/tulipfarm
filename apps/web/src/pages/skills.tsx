import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { workspaceRoute, skillDetailRoute } from '@/router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { SkillsSample, StatePanel } from '@tulipfarm/sprout/state-panel';
import { DataList, DataListCell, DataListLink, DataListRow, DataListSecondary } from '@/components/data-list';
import { Add } from 'reicon-react/icons/Add';
import { BookOpen } from 'reicon-react/icons/BookOpen';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { Disclosure } from '@/components/disclosure';
import { ReadFeedback, ReadError } from '@/components/read-feedback';
import { useSkillApi, useSkills, useSkillDetail } from '@/features/skills/queries';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback } from '@/features/tables/feedback';
import type { ReadState } from '@/features/tables/request-state';
import { skillApi, type SkillCommand, type SkillDetail, type SkillListView } from '@/features/skills/api';
import { SkillLifecycle } from '@/features/skills/lifecycle';
import { useCatalogNavigation } from '@/lib/use-catalog-navigation';
import { SkillSharing } from '@/features/skills/sharing';
import { ImportSkillForm } from '@/features/skills/import-flow';
import { SkillPackageDetails } from '@/features/skills/package-details';
import { PackageFiles } from '@/features/skills/package-files';
import { isSkillScript } from '@tulipfarm/agents/skill-package-contracts';

function SkillRead<T>({
  state,
  refresh,
  children,
}: {
  state: ReadState<T>;
  refresh: () => Promise<void>;
  children: (data: T) => ReactNode;
}) {
  return (
    <ReadFeedback
      state={state}
      errorTitle="Could not load skills"
      retry={
        <Button variant="outline" onClick={() => void refresh()}>
          Retry skills
        </Button>
      }
      loading={
        <div role="status" aria-label="Loading skills" className="space-y-4">
          <Skeleton />
          <Skeleton />
          <span className="sr-only">Loading skills…</span>
        </div>
      }
      unavailable={() => (
        <StatePanel
          kind="unavailable"
          title="Skill unavailable"
          description="Your session or access may have changed. Return to workspaces or check access again."
        >
          <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
            Back to workspaces
          </Button>
          <Button variant="outline" onClick={() => void refresh()}>
            Check access again
          </Button>
        </StatePanel>
      )}
      refreshError={message => (
        <ReadError message={message}>
          <Button variant="outline" onClick={() => void refresh()}>
            Retry refresh
          </Button>
        </ReadError>
      )}
      refreshing={<p role="status">Refreshing skills…</p>}
    >
      {children}
    </ReadFeedback>
  );
}

const skillViews = new Map<string, SkillListView>();
const headingFocus = new Set<string>();
const catalogKey = (userId: string, workspaceId: string) => `${userId}/${workspaceId}/skills`;

export function SkillsPage() {
  const { workspace, user } = workspaceRoute.useRouteContext();
  const api = useSkillApi(workspace.id);
  const key = catalogKey(user.id, workspace.id);
  const pages = useCatalogNavigation(key);
  const [view, setView] = useState(() => skillViews.get(key) ?? 'visible');
  const [importOpen, setImportOpen] = useState(false);
  const { after, search } = pages;
  const read = useSkills(api, after, search, view);
  const heading = useRef<HTMLHeadingElement>(null);
  const activeToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (headingFocus.delete(key)) heading.current?.focus();
  }, [key]);
  const show = (next: SkillListView) => {
    skillViews.set(key, next);
    setView(next);
    pages.first();
  };
  const archived = view === 'archived';
  return (
    <PageContent>
      <PageHeader
        titleRef={heading}
        focusable
        title="Skills"
        description="Reusable procedures. Skills never grant tools or permissions."
        actions={<Button onClick={() => setImportOpen(true)}>Import skill</Button>}
      />
      <div>
        <Button
          variant="link"
          nativeButton={false}
          render={
            <Link to="/$workspaceSlug" params={{ workspaceSlug: workspace.slug }} search={{ intent: 'create-skill' }} />
          }
        >
          Ask chat to make a skill
        </Button>
      </div>
      {importOpen && <ImportSkillForm />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchField
          id="skill-search"
          label="Find skills"
          placeholder="Search skills"
          maxLength={120}
          value={search}
          onChange={pages.setSearch}
        />
        <div className="flex gap-1">
          <Button
            ref={activeToggle}
            variant={archived ? 'ghost' : 'secondary'}
            aria-label="Active skills"
            aria-pressed={!archived}
            onClick={() => show('visible')}
          >
            Active
          </Button>
          <Button
            variant={archived ? 'secondary' : 'ghost'}
            aria-label="Archived skills"
            aria-pressed={archived}
            onClick={() => show('archived')}
          >
            Archived
          </Button>
        </div>
      </div>
      <SkillRead state={read.state} refresh={read.refresh}>
        {data => (
          <>
            <section className="min-w-0 space-y-3">
              <h2 className="text-sm font-medium">{archived ? 'Archived skills' : 'Workspace skills'}</h2>
              {data.workspace.length ? (
                <DataList
                  aria-label={archived ? 'Archived skills' : 'Workspace skills'}
                  columns="three"
                  headings={['Name', 'Source', 'Status']}
                >
                  {data.workspace.map(skill => (
                    <DataListRow key={skill.id}>
                      <DataListCell>
                        <DataListLink
                          render={
                            <Link
                              to="/$workspaceSlug/skills/$skillId"
                              params={{ workspaceSlug: workspace.slug, skillId: skill.id }}
                            />
                          }
                        >
                          {skill.name}
                        </DataListLink>
                        {skill.description && (
                          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{skill.description}</p>
                        )}
                      </DataListCell>
                      <DataListSecondary>{skill.source}</DataListSecondary>
                      <DataListCell>
                        {
                          {
                            enabled: 'Enabled',
                            disabled: 'Disabled',
                            'needs-review': 'Needs review',
                            archived: 'Archived',
                          }[skill.status]
                        }
                      </DataListCell>
                    </DataListRow>
                  ))}
                </DataList>
              ) : search ? (
                <StatePanel
                  kind="empty"
                  heading="h3"
                  icon={BookOpen}
                  title={archived ? 'No matching archived skills' : 'No matching workspace skills'}
                  description="Try another name or clear your search."
                >
                  <Button variant="outline" onClick={() => pages.setSearch('')}>
                    Clear search
                  </Button>
                </StatePanel>
              ) : archived ? (
                <StatePanel
                  kind="empty"
                  heading="h3"
                  icon={BookOpen}
                  title="No archived skills"
                  description="Skills you archive appear here. Open one to restore or delete it."
                >
                  <Button
                    variant="outline"
                    onClick={() => {
                      show('visible');
                      activeToggle.current?.focus();
                    }}
                  >
                    Show active skills
                  </Button>
                </StatePanel>
              ) : (
                <StatePanel
                  kind="empty"
                  heading="h3"
                  icon={BookOpen}
                  title="No workspace skills yet"
                  description="Import a skill, or ask chat to make one for a task you repeat. Review it once to save and enable it privately."
                  sample={<SkillsSample />}
                >
                  <Button onClick={() => setImportOpen(true)}>
                    <Add size={16} aria-hidden="true" />
                    Import skill
                  </Button>
                </StatePanel>
              )}
              {(after || data.nextCursor) && (
                <nav aria-label="Skill pages" className="flex flex-wrap items-center gap-2">
                  {after && (
                    <>
                      <Button variant="outline" onClick={pages.first}>
                        First page
                      </Button>
                      <Button variant="outline" onClick={pages.previous}>
                        Previous page
                      </Button>
                    </>
                  )}
                  <span className="text-sm text-muted-foreground">Page {pages.page}</span>
                  {data.nextCursor && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (data.nextCursor) pages.next(data.nextCursor);
                      }}
                    >
                      Next page
                    </Button>
                  )}
                </nav>
              )}
            </section>
          </>
        )}
      </SkillRead>
    </PageContent>
  );
}

export function SkillDetailPage() {
  const { skillId } = skillDetailRoute.useParams();
  return <SkillPage key={skillId} id={skillId} />;
}
function SkillPage({ id }: { id: string }) {
  const { workspace, user } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  const api = useSkillApi(workspace.id);
  const [deleted, setDeleted] = useState(false);
  const read = useSkillDetail(api, id);
  const leave = () => {
    setDeleted(true);
    headingFocus.add(catalogKey(user.id, workspace.id));
    void navigate({
      to: '/$workspaceSlug/skills',
      params: { workspaceSlug: workspace.slug },
      replace: true,
      ignoreBlocker: true,
    });
  };
  return (
    <PageContent>
      <PageHeader
        back={{
          label: 'Back to skills',
          link: <Link to="/$workspaceSlug/skills" params={{ workspaceSlug: workspace.slug }} />,
        }}
        title="Workspace skill"
      />
      {deleted ? (
        <p role="status">Skill deleted.</p>
      ) : (
        <SkillRead state={read.state} refresh={read.refresh}>
          {detail => (
            <>
              <SkillContent api={api} id={id} detail={detail} refresh={read.refresh} deleted={leave} />
              {detail.management && (
                <SkillSharing api={api} id={id} workspaceId={workspace.id} refresh={read.refresh} />
              )}
            </>
          )}
        </SkillRead>
      )}
    </PageContent>
  );
}
function SkillContent({
  api,
  id,
  detail,
  refresh,
  deleted,
}: {
  api: ReturnType<typeof skillApi>;
  id: string;
  detail: SkillDetail;
  refresh: () => Promise<void>;
  deleted: () => void;
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const [message, setMessage] = useState('');
  const write = useTableWrite(
    (command: SkillCommand) => api.send(id, command),
    receipt => {
      setMessage(receipt.enabled ? 'Reviewed skill enabled.' : 'Skill disabled.');
      void refresh();
    },
  );
  const busy = write.state.kind === 'sending' || write.state.kind === 'uncertain';
  const management = detail.management;
  const archived = detail.lifecycle === 'archived';
  const banner = archived && (
    <Alert role="note">
      <AlertDescription>
        This skill is archived. It's hidden from skill lists and pickers. Agents that pin it keep working.
      </AlertDescription>
    </Alert>
  );
  return (
    <section className="min-w-0 space-y-6">
      {banner}
      <div className="space-y-2">
        <h2 className="break-words text-lg font-medium">{detail.definition.name}</h2>
        <p>
          {detail.definition.package?.manifest.metadata.description ??
            detail.definition.description ??
            'Reusable workspace procedure.'}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {!archived && (!management || management.enabled) && (
          <Button
            nativeButton={false}
            render={
              <Link
                to="/$workspaceSlug"
                params={{ workspaceSlug }}
                search={{
                  intent: 'use-skill',
                  skillId: id,
                  skillRevision: management?.activeRevision ?? detail.revision,
                }}
              />
            }
          >
            Use in chat
          </Button>
        )}
        {management && !archived && (
          <Button
            variant="outline"
            nativeButton={false}
            render={
              <Link
                to="/$workspaceSlug"
                params={{ workspaceSlug }}
                search={{ intent: 'edit-skill', skillId: id, skillVersion: management.version }}
              />
            }
          >
            Edit in chat
          </Button>
        )}
      </div>
      <section aria-label="Procedure" className="space-y-2">
        <h3 className="font-medium">Procedure</h3>
        <p className="whitespace-pre-wrap break-words">{detail.definition.instructions}</p>
      </section>
      {detail.definition.package && (
        <Disclosure title="Package files">
          <ul className="space-y-2">
            {detail.definition.package.manifest.files.map(file => (
              <li key={file.path} className="break-all text-sm">
                {file.path} <span className="text-muted-foreground">{file.size.toLocaleString()} bytes</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm">
            License: {detail.definition.package.manifest.metadata.license ?? 'Not supplied'}
          </p>
        </Disclosure>
      )}
      {detail.definition.package && (
        <SkillPackageDetails
          api={api}
          id={id}
          revision={detail.revision}
          canUpdate={!!management && !archived}
          canReadHistory={!!management}
          needsRuntime={detail.definition.package.manifest.files.some(file => isSkillScript(file.path))}
        />
      )}
      {detail.definition.package && (
        <Disclosure title="Read package files">
          <PackageFiles
            identity={`${id}/${detail.revision}`}
            files={detail.definition.package.manifest.files}
            load={(path, offset, signal) => api.preview(id, detail.revision, path, offset, signal)}
          />
        </Disclosure>
      )}
      {archived && <p className="text-sm text-muted-foreground">Restore this skill to edit or review it.</p>}
      {message && <p role="status">{message}</p>}
      <WriteFeedback
        state={write.state}
        checkStatus={() => void refresh()}
        retry={command => void write.submit(command)}
      />
      {management && (
        <section aria-label="Skill review" className="space-y-3 border-t pt-6">
          <h2 className="text-lg font-medium">Review and availability</h2>
          <p>
            {management.enabled
              ? management.savedRevision === management.activeRevision
                ? 'The saved procedure is reviewed and enabled.'
                : 'An earlier reviewed procedure is enabled. This draft is not active.'
              : 'This skill is not enabled.'}
          </p>
          {management.savedRevision !== management.activeRevision && (
            <section aria-label="Procedure comparison" className="grid min-w-0 gap-4 sm:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <h3 className="font-medium">Previously reviewed procedure</h3>
                <p>{detail.reviewedDefinition?.name ?? 'No reviewed revision'}</p>
                <p className="whitespace-pre-wrap break-words">
                  {detail.reviewedDefinition?.instructions ?? 'This is the first review.'}
                </p>
              </div>
              <div className="min-w-0 space-y-2">
                <h3 className="font-medium">Saved procedure to review</h3>
                <p>{detail.definition.name}</p>
                <p className="whitespace-pre-wrap break-words">{detail.definition.instructions}</p>
              </div>
            </section>
          )}
          <Disclosure title="Exact revision identifiers">
            <dl className="space-y-3 text-sm">
              <div aria-label="Saved draft revision">
                <dt className="font-medium">Saved draft SHA-256</dt>
                <dd className="break-all font-mono">{management.savedRevision}</dd>
              </div>
              <div aria-label="Reviewed revision">
                <dt className="font-medium">Reviewed SHA-256</dt>
                <dd className="break-all font-mono">{management.activeRevision ?? 'Not reviewed'}</dd>
              </div>
            </dl>
          </Disclosure>
          <p className="text-sm text-muted-foreground">
            Review applies to this exact saved revision. Existing agents keep their selected revision. Disabling blocks
            every revision of this skill.
          </p>
          {detail.canReview ? (
            <>
              <p>
                Review the saved procedure above. Enabling makes reviewed revisions reusable by people with explicit use
                access. It does not activate an agent or share the skill.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    busy || archived || (management.enabled && management.savedRevision === management.activeRevision)
                  }
                  onClick={() =>
                    void write.submit({
                      kind: 'review',
                      requestId: crypto.randomUUID(),
                      expectedVersion: management.version,
                      revision: management.savedRevision,
                    })
                  }
                >
                  Review and enable
                </Button>
                {management.activeRevision && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void write.submit({
                        kind: 'enable',
                        requestId: crypto.randomUUID(),
                        expectedVersion: management.version,
                        enabled: !management.enabled,
                      })
                    }
                  >
                    {management.enabled ? 'Disable skill' : 'Enable reviewed skill'}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p>A skill manager must review and enable this draft.</p>
          )}
        </section>
      )}
      {detail.canManageLifecycle && management && (
        <SkillLifecycle
          api={api}
          id={id}
          name={detail.definition.name}
          workspaceSlug={workspaceSlug}
          archived={archived}
          version={management.version}
          refresh={refresh}
          onDeleted={deleted}
          onChanged={() => void refresh()}
        />
      )}
    </section>
  );
}
