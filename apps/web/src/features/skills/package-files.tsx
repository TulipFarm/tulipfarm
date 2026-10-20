import { useState } from 'react';
import type { z } from 'zod';
import type { skillPreviewSchema } from '@tulipfarm/agents/skill-import-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { ReadError, ReadFeedback } from '@/components/read-feedback';
import { useFeatureRead } from '@/lib/query';

export function PackageFiles({
  identity,
  files,
  load,
}: {
  identity: string;
  files: readonly { path: string; size: number }[];
  load: (path: string, offset: number, signal: AbortSignal) => Promise<z.infer<typeof skillPreviewSchema>>;
}) {
  const [selected, setSelected] = useState<{ path: string; offset: number } | null>(null);
  return (
    <div className="min-w-0 space-y-4">
      <ul className="space-y-1">
        {files.map(file => (
          <li key={file.path} className="min-w-0 text-sm">
            <Button variant="link" onClick={() => setSelected({ path: file.path, offset: 0 })}>
              <span className="whitespace-normal break-all text-left">{file.path}</span>
            </Button>
            <span className="text-muted-foreground"> ({file.size.toLocaleString()} bytes)</span>
          </li>
        ))}
      </ul>
      {selected && (
        <FilePreview
          key={`${identity}/${selected.path}/${selected.offset}`}
          identity={identity}
          selected={selected}
          load={load}
          next={offset => setSelected({ ...selected, offset })}
        />
      )}
    </div>
  );
}
function FilePreview({
  identity,
  selected,
  load,
  next,
}: {
  identity: string;
  selected: { path: string; offset: number };
  load: (path: string, offset: number, signal: AbortSignal) => Promise<z.infer<typeof skillPreviewSchema>>;
  next: (offset: number) => void;
}) {
  const read = useFeatureRead({
    key: ['skill-files', identity, selected.path, selected.offset],
    load: signal => load(selected.path, selected.offset, signal),
  });
  const retry = (
    <Button variant="outline" onClick={() => void read.refresh()}>
      Retry file
    </Button>
  );
  return (
    <section aria-label={`File ${selected.path}`} className="min-w-0 space-y-3 rounded border p-3">
      <h4 className="break-all text-sm font-medium">{selected.path}</h4>
      <ReadFeedback
        state={read.state}
        errorTitle="Could not read the file"
        retry={retry}
        loading={<p role="status">Loading file…</p>}
        unavailable={() => <p role="alert">This file or your access changed. Reopen the skill.</p>}
        refreshError={message => <ReadError message={message}>{retry}</ReadError>}
      >
        {file =>
          file.kind === 'binary' ? (
            <p className="text-sm">
              Binary asset, {file.size.toLocaleString()} bytes. Files are not executed and remote content is not loaded
              here.
            </p>
          ) : (
            <>
              <pre className="whitespace-pre-wrap break-all text-sm">{file.text || '(Empty file)'}</pre>
              <div className="flex flex-wrap gap-2">
                {selected.offset > 0 && (
                  <Button variant="outline" onClick={() => next(Math.max(0, selected.offset - 16000))}>
                    Previous part
                  </Button>
                )}
                {file.nextOffset !== null && (
                  <Button variant="outline" onClick={() => next(file.nextOffset!)}>
                    Next part
                  </Button>
                )}
              </div>
            </>
          )
        }
      </ReadFeedback>
    </section>
  );
}
