import { useEffect, useRef, useState } from 'react';
import { Download } from 'reicon-react/icons/Download';
import { Edit } from 'reicon-react/icons/Edit';
import { Image as ImageIcon } from 'reicon-react/icons/Image';
import { Button } from '@tulipfarm/sprout/button';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { fileKeys, fileUrl, useFilesApi } from '@/features/files/api';
import { useFeatureRead } from '@/lib/query';
import { useOptionalCanvas } from './canvas-state';
import type { ImageReceipt } from './conversation-api';

const settled: Record<Exclude<ImageReceipt['state'], 'pending' | 'saved'>, string> = {
  refused: 'The provider refused this image',
  failed: 'This image couldn’t be created',
  cancelled: 'Image cancelled',
};

/** One card per image of an `images.generate` call, each resolving on its own. */
export function ImageCards({
  workspaceId,
  slug,
  images,
}: {
  workspaceId: string;
  slug: string;
  images: readonly ImageReceipt[];
}) {
  return (
    <ul aria-label="Images created in this reply" className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
      {[...images]
        .sort((left, right) => left.index - right.index)
        .map(image => (
          <li key={image.id} className="min-w-0">
            {image.state === 'saved' ? (
              <SavedImage workspaceId={workspaceId} slug={slug} fileId={image.id} />
            ) : image.state === 'pending' ? (
              <div
                role="status"
                className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border bg-muted/40 text-sm text-muted-foreground"
              >
                <Spinner />
                Creating image…
              </div>
            ) : (
              <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
                <ImageIcon size={20} aria-hidden="true" />
                {settled[image.state]}
              </div>
            )}
          </li>
        ))}
    </ul>
  );
}

type Thumbnail = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; url: string };

function SavedImage({ workspaceId, slug, fileId }: { workspaceId: string; slug: string; fileId: string }) {
  const api = useFilesApi(workspaceId);
  const canvas = useOptionalCanvas();
  const read = useFeatureRead({ key: fileKeys.item(fileId), load: signal => api.read(fileId, signal) });
  const [thumbnail, setThumbnail] = useState<Thumbnail>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [download, setDownload] = useState<'idle' | 'sending' | 'failed'>('idle');
  const saving = useRef<AbortController | null>(null);
  const readable = read.state.kind === 'ready';
  useEffect(() => {
    if (!readable) return;
    const controller = new AbortController();
    let url: string | null = null;
    setThumbnail({ kind: 'loading' });
    api.content(fileId, controller.signal).then(
      bytes => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        setThumbnail({ kind: 'ready', url });
      },
      () => {
        if (!controller.signal.aborted) setThumbnail({ kind: 'failed' });
      },
    );
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, fileId, readable, attempt]);
  useEffect(() => () => saving.current?.abort(), []);

  if (read.state.kind === 'loading')
    return (
      <div
        role="status"
        aria-label="Loading image"
        className="flex aspect-square items-center justify-center rounded-xl border bg-muted/40"
      >
        <Spinner />
      </div>
    );
  if (read.state.kind === 'unavailable')
    return <p className="text-sm text-muted-foreground">An image created in this reply is unavailable to you.</p>;
  if (read.state.kind === 'error')
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-sm text-muted-foreground">
          Couldn’t load image details.
        </p>
        <Button size="sm" variant="outline" onClick={() => void read.refresh()}>
          Retry image details
        </Button>
      </div>
    );
  const file = read.state.data;
  const open = () =>
    canvas
      ? canvas.show({
          id: `file:${file.id}`,
          title: file.name,
          content: {
            kind: 'workspace-file',
            workspaceId,
            fileId: file.id,
            name: file.name,
            mediaType: file.mediaType ?? 'image/png',
          },
        })
      : window.open(fileUrl(slug, file), '_blank', 'noopener');
  async function save() {
    if (saving.current) return;
    const controller = new AbortController();
    saving.current = controller;
    setDownload('sending');
    try {
      const bytes = await api.content(file.id, controller.signal);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownload('idle');
    } catch {
      if (!controller.signal.aborted) setDownload('failed');
    } finally {
      if (saving.current === controller) saving.current = null;
    }
  }
  return (
    <figure aria-label={`Image: ${file.name}`} className="overflow-hidden rounded-xl border bg-card">
      <div className="aspect-square bg-muted/40">
        {thumbnail.kind === 'ready' ? (
          <img src={thumbnail.url} alt={file.name} className="size-full object-cover" />
        ) : thumbnail.kind === 'loading' ? (
          <span className="flex size-full items-center justify-center">
            <Spinner />
          </span>
        ) : (
          <span className="flex size-full items-center justify-center text-sm text-muted-foreground">
            Image unavailable
          </span>
        )}
      </div>
      <figcaption className="space-y-2 p-3">
        <p className="truncate text-sm font-medium" title={file.name}>
          {file.name}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" aria-label={`Open ${file.name}`} onClick={open}>
            Open
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={download === 'sending'}
            aria-busy={download === 'sending'}
            aria-label={`Download ${file.name}`}
            onClick={() => void save()}
          >
            <Download size={14} aria-hidden="true" />
            {download === 'sending' ? 'Downloading…' : 'Download'}
          </Button>
          {canvas && (
            <Button
              size="sm"
              variant="outline"
              aria-label={`Edit ${file.name}`}
              onClick={() =>
                canvas.requestComposer('', [
                  {
                    source: 'tulipfarm',
                    id: file.id,
                    name: file.name,
                    mediaType: file.mediaType ?? 'image/png',
                    size: file.size,
                  },
                ])
              }
            >
              <Edit size={14} aria-hidden="true" />
              Edit
            </Button>
          )}
        </div>
        {thumbnail.kind === 'failed' && (
          <Button size="sm" variant="link" onClick={() => setAttempt(value => value + 1)}>
            Retry image
          </Button>
        )}
        {download === 'failed' && (
          <p role="alert" className="text-sm text-muted-foreground">
            The download didn’t finish. Select Download to try again.
          </p>
        )}
      </figcaption>
    </figure>
  );
}
