import { useMemo } from 'react';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFeatureRead } from '@/lib/query';
import {
  knowledgeSourceFailureKeys,
  knowledgeSourceFailuresApi,
  type KnowledgeSourceFailure,
} from './knowledge-source-failures-api';
import { ReadResult } from './slack-knowledge-shared';

const statusLabels: Record<KnowledgeSourceFailure['status'], string> = {
  failed: 'Not searchable',
  'ocr-unavailable': 'Scanned, not searchable',
  'raw-text': 'Searchable as plain text',
};
const reasonLabels: Record<string, string> = {
  unsupported: 'This file type cannot be read.',
  encrypted: 'The file is encrypted or password protected.',
  malformed: 'The file is damaged or not in the format its name suggests.',
  'resource-limited': 'The file is too large or too complex to read.',
  'ocr-required': 'The file contains only scanned images, and text recognition is unavailable.',
  provider: 'The file could not be fetched or read after several attempts.',
  credits: 'Indexing paused because the workspace has no credits left.',
};

const time = (value: string) => new Date(value).toLocaleString();

// Lists items in one Knowledge source that failed to import or were indexed from raw text. Owner-only.
export function KnowledgeSourceFailures({ workspaceId, sourceId }: { workspaceId: string; sourceId: string }) {
  const api = useMemo(() => knowledgeSourceFailuresApi(workspaceId), [workspaceId]);
  const read = useFeatureRead({
    key: [...knowledgeSourceFailureKeys, workspaceId, sourceId],
    load: signal => api.list(sourceId, signal),
    staleTime: 0,
  });
  return (
    <section aria-label="Items with import problems" className="space-y-3 border-t pt-3">
      <h5 className="text-sm font-medium">Import problems</h5>
      <ReadResult state={read.state} retry={read.refresh} label="import problems">
        {data => (
          <>
            <p className="text-sm text-muted-foreground">
              {data.syncedAt ? `Last sync completed ${time(data.syncedAt)}.` : 'No completed sync recorded yet.'}
            </p>
            {!data.items.length ? (
              <StatePanel
                kind="empty"
                heading="h3"
                title="No import problems"
                description="Every item read so far is searchable."
              />
            ) : (
              <ul className="divide-y" aria-label="Items with import problems">
                {data.items.map(item => (
                  <li key={item.documentId} className="space-y-1 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      {item.canonicalUrl ? (
                        <a className="font-medium underline" href={item.canonicalUrl} target="_blank" rel="noreferrer">
                          {item.title}
                        </a>
                      ) : (
                        <span className="font-medium">{item.title}</span>
                      )}
                      <Badge variant={item.status === 'raw-text' ? 'secondary' : 'warning'}>
                        {statusLabels[item.status]}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground">
                      {reasonLabels[item.reason] ?? 'The item could not be read.'}
                      {item.status === 'raw-text' ? ' Its text was indexed without formatting.' : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Seen {time(item.observedAt)}
                      {item.attempts > 1 ? ` · ${item.attempts} attempts` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {data.truncated && (
              <p className="text-sm text-muted-foreground">Showing the first {data.items.length} items.</p>
            )}
          </>
        )}
      </ReadResult>
      <Button
        variant="outline"
        disabled={read.state.kind === 'loading' || (read.state.kind === 'ready' && read.state.refreshing)}
        onClick={() => void read.refresh()}
      >
        Check import problems again
      </Button>
    </section>
  );
}
