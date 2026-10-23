import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AttachmentGroup, FileAttachment } from '@tulipfarm/sprout/attachment';
import { Button } from '@tulipfarm/sprout/button';
import { FileRenderersProvider, FileViewer } from '@tulipfarm/sprout/file-viewer';
import { fileRenderers } from '@/features/files/viewer/renderers';
import { formatFileSize } from '@/lib/file-viewer';
import type { ConversationApi } from './conversation-api';
import type { FileReference } from './draft-files';
import { useConversationAttachment, useConversationChanges } from './queries';

type StagedFile = { id: string; file: File } & (
  | { kind: 'uploading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }
);

export function useConversationAttachments(api: ConversationApi, chatId: string) {
  const changes = useConversationChanges();
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [error, setError] = useState('');
  const active = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  const cancelled = useRef(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    const transfers = active.current;
    return () => {
      mounted.current = false;
      for (const controller of transfers.values()) controller.abort();
      transfers.clear();
    };
  }, []);
  async function upload(item: StagedFile) {
    if (active.current.has(item.id)) return;
    const controller = new AbortController();
    active.current.set(item.id, controller);
    setFiles(current =>
      current.map(file => (file.id === item.id ? { id: item.id, file: item.file, kind: 'uploading' } : file)),
    );
    try {
      await api.upload(chatId, item.id, item.file, AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]));
      void changes.created(chatId);
      if (!controller.signal.aborted)
        setFiles(current =>
          current.map(file => (file.id === item.id ? { id: item.id, file: item.file, kind: 'ready' } : file)),
        );
    } catch (cause) {
      if (!controller.signal.aborted)
        setFiles(current =>
          current.map(file =>
            file.id === item.id
              ? {
                  id: item.id,
                  file: item.file,
                  kind: 'error',
                  message: cause instanceof Error ? cause.message : 'Upload failed. Retry this file.',
                }
              : file,
          ),
        );
    } finally {
      active.current.delete(item.id);
    }
  }
  function add(picked: File[]) {
    if (files.length + picked.length > 5) {
      setError('Attach at most five files per message.');
      return;
    }
    if (picked.some(file => file.size === 0 || file.size > 10 * 1024 * 1024)) {
      setError('Choose nonempty files no larger than 10 MiB each.');
      return;
    }
    setError('');
    const added = picked.map((file): StagedFile => ({ id: crypto.randomUUID(), file, kind: 'uploading' }));
    setFiles(current => [...current, ...added]);
    void (async () => {
      for (const item of added) {
        if (!mounted.current || cancelled.current.has(item.id)) continue;
        await upload(item);
      }
    })();
  }
  function remove(id: string) {
    cancelled.current.add(id);
    active.current.get(id)?.abort();
    setFiles(current => current.filter(file => file.id !== id));
  }
  return {
    files,
    error,
    add,
    retry: upload,
    remove,
    clear: () => {
      setFiles([]);
      setError('');
    },
    ready: files.every(file => file.kind === 'ready'),
  };
}

function uploadSummary(files: ReturnType<typeof useConversationAttachments>['files']) {
  const uploading = files.filter(file => file.kind === 'uploading').length;
  const ready = files.filter(file => file.kind === 'ready').length;
  if (uploading) return `Uploading ${uploading} ${uploading === 1 ? 'file' : 'files'}…`;
  if (ready) return `${ready} ${ready === 1 ? 'file' : 'files'} ready to send`;
  return '';
}

export function StagedAttachments({
  uploads,
  disabled,
  references,
  blocked,
}: {
  uploads: ReturnType<typeof useConversationAttachments>;
  disabled: boolean;
  blocked?: ReactNode;
  references?: { items: readonly FileReference[]; notice: string | null };
}) {
  const referenced = references?.items ?? [];
  if (!uploads.files.length && !uploads.error && !referenced.length && !references?.notice) return null;
  return (
    <div className="space-y-2">
      {!!uploads.files.length && (
        <FileRenderersProvider renderers={fileRenderers}>
          <AttachmentGroup variant="carousel" aria-label="Attached files">
            {uploads.files.map(item => (
              <FileAttachment
                key={item.id}
                variant="chip"
                viewable
                preview
                file={{
                  id: item.id,
                  name: item.file.name,
                  mediaType: item.file.type,
                  size: formatFileSize(item.file.size),
                  state: item.kind,
                  source: { kind: 'local', file: item.file },
                }}
                onRemove={disabled ? undefined : () => uploads.remove(item.id)}
                onRetry={disabled ? undefined : () => void uploads.retry(item)}
              />
            ))}
          </AttachmentGroup>
        </FileRenderersProvider>
      )}
      {!!referenced.length && (
        <p className="text-xs text-muted-foreground">
          The assistant reads {referenced.length === 1 ? 'this file' : 'these files'}{' '}
          {referenced.every(item => item.source === 'google')
            ? 'from Google Drive through your Google account'
            : referenced.some(item => item.source === 'google')
              ? 'from Files and Google Drive'
              : 'from Files'}{' '}
          for your requests in this chat, using your current access.
        </p>
      )}
      {references?.notice && (
        <p role="alert" className="text-sm text-destructive">
          {references.notice}
        </p>
      )}
      {blocked}
      {uploads.files.map(
        item =>
          item.kind === 'error' && (
            <p key={item.id} role="alert" className="break-words text-sm text-destructive">
              {item.file.name}: {item.message}
            </p>
          ),
      )}
      {uploads.error && (
        <p role="alert" className="text-sm text-destructive">
          {uploads.error}
        </p>
      )}
      <p role="status" className="sr-only">
        {uploadSummary(uploads.files)}
      </p>
      {!!uploads.files.length && (
        <p className="text-xs text-muted-foreground">
          Stored privately for download. The assistant can’t read uploaded files.
        </p>
      )}
    </div>
  );
}

export function ConversationAttachment({ api, chatId, id }: { api: ConversationApi; chatId: string; id: string }) {
  const read = useConversationAttachment(api, chatId, id);
  const [fetching, setFetching] = useState<'idle' | 'loading' | 'error'>('idle');
  const [loaded, setLoaded] = useState<File | null>(null);
  const [open, setOpen] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function view(filename: string, mediaType: string) {
    if (loaded) {
      setOpen(true);
      return;
    }
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setFetching('loading');
    try {
      const blob = await api.download(chatId, id, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]));
      controller.signal.throwIfAborted();
      setLoaded(new File([blob], filename, { type: mediaType || blob.type }));
      setOpen(true);
      setFetching('idle');
    } catch {
      if (!controller.signal.aborted) setFetching('error');
    } finally {
      active.current = null;
    }
  }
  if (read.state.kind === 'loading')
    return (
      <p data-slot="conversation-attachment" role="status">
        Loading attachment…
      </p>
    );
  if (read.state.kind !== 'ready')
    return (
      <div data-slot="conversation-attachment">
        <p role="alert">Attachment unavailable. Your messages remain saved.</p>
        <Button size="sm" variant="outline" onClick={() => void read.refresh()}>
          Retry attachment
        </Button>
      </div>
    );
  const file = read.state.data;
  return (
    <div data-slot="conversation-attachment" className="space-y-2">
      <FileAttachment
        variant="chip"
        onOpen={() => void view(file.filename, file.mediaType)}
        file={{
          id,
          name: file.filename,
          mediaType: file.mediaType,
          size: formatFileSize(file.size),
          state: fetching === 'loading' ? 'processing' : 'ready',
        }}
      />
      {fetching === 'error' && (
        <p role="alert">Couldn't open the file. Select it to retry. Your messages remain saved.</p>
      )}
      <FileViewer
        file={loaded && { name: loaded.name, mediaType: loaded.type, source: { kind: 'local', file: loaded } }}
        open={open && !!loaded}
        onOpenChange={setOpen}
        renderers={fileRenderers}
      />
    </div>
  );
}
