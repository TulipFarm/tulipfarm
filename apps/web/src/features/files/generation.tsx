import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { useFeatureRead } from '@/lib/query';
import { fileKeys, type FilesApi } from './api';

/** How a generated image was made. Renders nothing for a file that was not generated. */
export function GenerationDetails({
  api,
  fileId,
  workspaceSlug,
}: {
  api: FilesApi;
  fileId: string;
  workspaceSlug: string;
}) {
  const details = useFeatureRead({ key: fileKeys.details(fileId), load: signal => api.details(fileId, signal) });
  const generation = details.state.kind === 'ready' ? details.state.data.generation : null;
  if (!generation) return null;
  const { hiddenSources, sources, origin } = generation;
  return (
    <section aria-labelledby="generated-heading" className="space-y-3">
      <h2 id="generated-heading" className="text-sm font-medium">
        Generated
      </h2>
      <dl className="divide-y rounded-lg border">
        <Row label="Prompt">
          <span className="whitespace-pre-wrap">{generation.prompt}</span>
        </Row>
        <Row label="Image model">{generation.imageModelId}</Row>
        <Row label="Made in">
          {origin.kind === 'turn' ? (
            <Button
              variant="link"
              size="sm"
              nativeButton={false}
              role="link"
              render={
                <Link to="/$workspaceSlug/chat/$chatId" params={{ workspaceSlug, chatId: origin.conversationId }} />
              }
            >
              A chat
            </Button>
          ) : (
            'An agent run'
          )}
        </Row>
        {(sources.length > 0 || hiddenSources > 0) && (
          <Row label="Sources">
            <ul className="space-y-1">
              {sources.map(source => (
                <li key={source.id}>
                  <SourceLink api={api} fileId={source.id} workspaceSlug={workspaceSlug} />
                </li>
              ))}
              {hiddenSources > 0 && (
                <li className="text-muted-foreground">
                  {hiddenSources === 1 ? '1 source you can’t open' : `${hiddenSources} sources you can’t open`}
                </li>
              )}
            </ul>
          </Row>
        )}
      </dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-3 py-2 sm:grid-cols-3 sm:gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-foreground sm:col-span-2">{children}</dd>
    </div>
  );
}

function SourceLink({ api, fileId, workspaceSlug }: { api: FilesApi; fileId: string; workspaceSlug: string }) {
  const read = useFeatureRead({ key: fileKeys.item(fileId), load: signal => api.read(fileId, signal) });
  return (
    <Button
      variant="link"
      size="sm"
      nativeButton={false}
      role="link"
      render={<Link to="/$workspaceSlug/files/$fileId" params={{ workspaceSlug, fileId }} />}
    >
      {read.state.kind === 'ready' ? read.state.data.name : 'Source image'}
    </Button>
  );
}
