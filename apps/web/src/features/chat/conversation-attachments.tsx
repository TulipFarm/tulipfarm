import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AttachmentGroup, FileAttachment } from '@tulipfarm/sprout/attachment';
import { Button } from '@tulipfarm/sprout/button';
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
        <AttachmentGroup variant="carousel" aria-label="Attached files">
          {uploads.files.map(item => (
            <FileAttachment
              key={item.id}
              variant="chip"
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
      {uploads.files.map(item => (
        <p
          key={item.id}
          role={item.kind === 'error' ? 'alert' : 'status'}
          className="break-words text-xs text-muted-foreground"
        >
          {item.file.name}:{' '}
          {item.kind === 'ready'
            ? 'Ready to send · Storage only, not read by this chat'
            : item.kind === 'uploading'
              ? 'Uploading for private storage…'
              : item.message}
        </p>
      ))}
      {uploads.error && (
        <p role="alert" className="text-sm text-destructive">
          {uploads.error}
        </p>
      )}
      {!!uploads.files.length && (
        <p className="text-xs text-muted-foreground">
          Files are saved privately for download. The assistant cannot read their contents.
        </p>
      )}
    </div>
  );
}

export function ConversationAttachment({ api, chatId, id }: { api: ConversationApi; chatId: string; id: string }) {
  const read = useConversationAttachment(api, chatId, id);
  const [download, setDownload] = useState<'idle' | 'loading' | 'error'>('idle');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function save(filename: string) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setDownload('loading');
    try {
      const blob = await api.download(chatId, id, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]));
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      setDownload('idle');
    } catch {
      if (!controller.signal.aborted) setDownload('error');
    } finally {
      active.current = null;
    }
  }
  if (read.state.kind === 'loading') return <p role="status">Loading attachment…</p>;
  if (read.state.kind !== 'ready')
    return (
      <div>
        <p role="alert">Attachment unavailable. Your messages remain saved.</p>
        <Button size="sm" variant="outline" onClick={() => void read.refresh()}>
          Retry attachment
        </Button>
      </div>
    );
  const file = read.state.data;
  return (
    <div className="space-y-2">
      <FileAttachment
        variant="chip"
        actionLabel="Download"
        onOpen={() => void save(file.filename)}
        file={{
          id,
          name: file.filename,
          mediaType: file.mediaType,
          size: formatFileSize(file.size),
          state: download === 'loading' ? 'processing' : 'ready',
        }}
      />
      {download === 'error' && (
        <p role="alert">Download failed. Select the file to retry. Your messages remain saved.</p>
      )}
    </div>
  );
}
