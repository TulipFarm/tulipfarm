import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { workspaceRoute } from '@/router';
import { Button } from '@tulipfarm/sprout/button';
import { ReadError, ReadFeedback } from '@/components/read-feedback';
import { Disclosure } from '@/components/disclosure';
import { useFeatureRead } from '@/lib/query';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback } from '@/features/tables/feedback';
import type { skillApi } from './api';

export function SkillPackageDetails({
  api,
  id,
  revision,
  canUpdate,
  needsRuntime,
  canReadHistory,
}: {
  api: ReturnType<typeof skillApi>;
  id: string;
  revision: string;
  canUpdate: boolean;
  needsRuntime: boolean;
  canReadHistory: boolean;
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  const read = useFeatureRead({
    key: ['skills', id, 'provenance', revision],
    load: signal => api.provenance(id, signal),
  });
  const open = (importId: string) =>
    void navigate({
      to: '/$workspaceSlug/skills/import/$importId',
      params: { workspaceSlug: workspace.slug, importId },
    });
  const write = useTableWrite(
    (importId: string) => api.update(id, importId),
    view => open(view.id),
  );
  const retry = (
    <Button variant="outline" onClick={() => void read.refresh()}>
      Retry source details
    </Button>
  );
  return (
    <section aria-label="Package source and review" className="min-w-0 space-y-3">
      <h3 className="font-medium">Source and safety review</h3>
      {needsRuntime && <SkillRuntimeStatus api={api} id={id} />}
      <ReadFeedback
        state={read.state}
        errorTitle="Could not read the package source"
        retry={retry}
        loading={<p role="status">Loading source details…</p>}
        unavailable={() => <p role="alert">Source details are unavailable. Your access may have changed.</p>}
        refreshError={message => <ReadError message={message}>{retry}</ReadError>}
      >
        {source =>
          source ? (
            <>
              <p className="break-all text-sm">
                {source.source.canonicalUrl === 'chat' ? 'Created in chat' : source.source.canonicalUrl}
              </p>
              {source.localChanges && (
                <p className="text-sm">
                  Edited locally in chat. An upstream update can replace these edits, or you can ask chat to merge the
                  changes.
                </p>
              )}
              <p>{source.report.ai.summary}</p>
              <p className="text-sm text-muted-foreground">
                Safety review is advice, not proof that this skill is safe.
              </p>
              <Disclosure title="Review findings and source details">
                <ul className="space-y-2">
                  {[...source.report.deterministic, ...source.report.ai.findings].map((finding, index) => (
                    <li key={index} className="break-words text-sm">
                      {finding.severity}: {finding.message} ({finding.path}
                      {finding.line ? `:${finding.line}` : ''})
                    </li>
                  ))}
                </ul>
                <dl className="mt-3 space-y-2 text-sm">
                  <div>
                    <dt>Source directory</dt>
                    <dd className="break-all">{source.path || 'Root package'}</dd>
                  </div>
                  <div>
                    <dt>Source commit</dt>
                    <dd className="break-all">{source.source.commit ?? 'Not a GitHub source'}</dd>
                  </div>
                  <div>
                    <dt>Previous revision</dt>
                    <dd className="break-all">{source.parentRevision ?? 'First saved version'}</dd>
                  </div>
                  <div>
                    <dt>Runtime profile</dt>
                    <dd>{source.report.runtimeProfile}. Scripts need the configured isolated runner.</dd>
                  </div>
                </dl>
              </Disclosure>
              {canUpdate && source.source.submittedUrl !== 'chat' && (
                <Button
                  variant="outline"
                  disabled={write.state.kind === 'sending' || write.state.kind === 'uncertain'}
                  onClick={() => void write.submit(crypto.randomUUID())}
                >
                  Check for updates
                </Button>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">This older revision has no stored import source.</p>
          )
        }
      </ReadFeedback>
      {canReadHistory && (
        <Disclosure title="Version history">
          <SkillHistory api={api} id={id} revision={revision} />
        </Disclosure>
      )}
      <WriteFeedback
        state={write.state}
        retry={input => void write.submit(input)}
        checkStatus={() => {
          if ('input' in write.state) open(write.state.input);
        }}
      />
    </section>
  );
}

function SkillHistory({ api, id, revision }: { api: ReturnType<typeof skillApi>; id: string; revision: string }) {
  const [offset, setOffset] = useState(0);
  const read = useFeatureRead({
    key: ['skills', id, 'history', revision, offset],
    load: signal => api.history(id, offset, signal),
  });
  const retry = (
    <Button variant="outline" onClick={() => void read.refresh()}>
      Retry version history
    </Button>
  );
  return (
    <ReadFeedback
      state={read.state}
      errorTitle="Could not read version history"
      retry={retry}
      loading={<p role="status">Loading version history…</p>}
      unavailable={() => <p role="alert">A retained source or your access to this history is unavailable.</p>}
      refreshError={message => <ReadError message={message}>{retry}</ReadError>}
    >
      {page => (
        <div className="space-y-3">
          {page.items.length ? (
            <ol className="space-y-4">
              {page.items.map(item => (
                <li key={item.revision} className="space-y-1 text-sm">
                  <p>
                    {new Date(item.createdAt).toLocaleString()}
                    {item.revision === revision ? ' · Current saved version' : ''}
                  </p>
                  <p className="break-all">
                    {item.provenance.source.canonicalUrl === 'chat'
                      ? 'Created in chat'
                      : item.provenance.source.canonicalUrl}
                  </p>
                  <p>{item.provenance.localChanges ? 'Edited locally in chat' : 'Original package snapshot'}</p>
                  <p className="break-all">Revision: {item.revision}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p>No package versions are recorded.</p>
          )}
          <div className="flex gap-2">
            {offset > 0 && (
              <Button variant="outline" onClick={() => setOffset(Math.max(0, offset - 20))}>
                Newer versions
              </Button>
            )}
            {page.nextOffset !== null && (
              <Button
                variant="outline"
                onClick={() => {
                  if (page.nextOffset !== null) setOffset(page.nextOffset);
                }}
              >
                Older versions
              </Button>
            )}
          </div>
        </div>
      )}
    </ReadFeedback>
  );
}

function SkillRuntimeStatus({ api, id }: { api: ReturnType<typeof skillApi>; id: string }) {
  const read = useFeatureRead({ key: ['skills', id, 'runtime'], load: signal => api.runtime(id, signal) });
  const retry = (
    <Button variant="outline" onClick={() => void read.refresh()}>
      Check script runner
    </Button>
  );
  return (
    <ReadFeedback
      state={read.state}
      errorTitle="Could not check the script runner"
      retry={retry}
      loading={<p role="status">Checking script support…</p>}
      unavailable={() => <p role="alert">Script support or your access changed.</p>}
      refreshError={message => <ReadError message={message}>{retry}</ReadError>}
    >
      {runtime => (
        <div className="space-y-2">
          <p className="text-sm">
            {runtime.available
              ? 'The isolated runner is available. This does not prove that every package dependency is supported.'
              : 'The isolated runner is unavailable. Scripts cannot run here.'}
          </p>
          {retry}
        </div>
      )}
    </ReadFeedback>
  );
}
