import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { AttachmentGroup, FileAttachment } from '@tulipfarm/sprout/attachment';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { PaperclipIcon } from '@tulipfarm/icons';
import { FileRenderersProvider, FileViewer } from '@tulipfarm/sprout/file-viewer';
import { fileRenderers } from '@/features/files/viewer/renderers';
import { apiOrigin } from '@/lib/auth';
import { readJson, responseError, writesAllowed } from '@/lib/http';
import { formatFileSize } from '@/lib/file-viewer';
import { z } from 'zod';
import { TableRequestError } from './request-state';

export const rowAttachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  mediaType: z.string(),
  size: z.number().int().positive(),
});
export type RowAttachment = z.infer<typeof rowAttachmentSchema>;

export const descriptionFileLimit = 10;
export const commentFileLimit = 5;
const maxBytes = 100 * 1024 * 1024;

function tableBase(workspaceId: string, tableId: string) {
  return `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/tables/${encodeURIComponent(tableId)}`;
}

async function failed(response: Response): Promise<never> {
  throw new TableRequestError(
    response.status,
    responseError(await readJson(response, true), 'row-attachment-unavailable'),
    response.status === 413
      ? 'This file is too large. The limit is 100 MiB.'
      : 'The file could not be saved. Try again.',
  );
}

export function rowAttachmentsApi(workspaceId: string, tableId: string) {
  const base = tableBase(workspaceId, tableId);
  return {
    async upload(file: File, signal: AbortSignal) {
      await writesAllowed();
      const query = new URLSearchParams({ name: file.name || 'pasted-image.png' });
      if (file.type) query.set('mediaType', file.type);
      const response = await fetch(`${base}/attachments?${query}`, {
        method: 'POST',
        credentials: 'include',
        signal,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      if (!response.ok) await failed(response);
      return rowAttachmentSchema.parse(await response.json());
    },
    async changeDescription(rowId: string, change: { add?: string[]; remove?: string[] }) {
      await writesAllowed();
      const response = await fetch(`${base}/rows/${encodeURIComponent(rowId)}/attachments`, {
        method: 'PUT',
        credentials: 'include',
        signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      });
      if (!response.ok) await failed(response);
    },
  };
}

const loaded = new Map<string, Promise<File>>();
const loadedLimit = 50;

function loadFile(workspaceId: string, tableId: string, rowId: string, file: RowAttachment) {
  let pending = loaded.get(file.id);
  if (pending) {
    loaded.delete(file.id);
    loaded.set(file.id, pending);
  } else {
    if (loaded.size >= loadedLimit) loaded.delete(loaded.keys().next().value!);
    pending = fetch(
      `${tableBase(workspaceId, tableId)}/rows/${encodeURIComponent(rowId)}/attachments/${encodeURIComponent(file.id)}/content`,
      { credentials: 'include', signal: AbortSignal.timeout(60_000) },
    ).then(async response => {
      if (!response.ok) throw new Error('row-attachment-download');
      return new File([await response.blob()], file.filename, { type: file.mediaType });
    });
    pending.catch(() => loaded.delete(file.id));
    loaded.set(file.id, pending);
  }
  return pending;
}

// ponytail: staged previews live until page unload; revoke on remove if many large pastes matter.
const stagedPreviews = new WeakMap<File, string>();
function stagedPreview(file: File) {
  if (!file.type.startsWith('image/')) return undefined;
  if (!stagedPreviews.has(file)) stagedPreviews.set(file, URL.createObjectURL(file));
  return stagedPreviews.get(file);
}

function useThumbnail(workspaceId: string, tableId: string, rowId: string, file: RowAttachment) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file.mediaType.startsWith('image/')) return;
    let objectUrl: string | undefined;
    let live = true;
    void loadFile(workspaceId, tableId, rowId, file)
      .then(blob => {
        if (!live) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workspaceId, tableId, rowId, file]);
  return url;
}

function SavedFile({
  workspaceId,
  tableId,
  rowId,
  file,
  look,
  open,
  remove,
}: {
  workspaceId: string;
  tableId: string;
  rowId: string;
  file: RowAttachment;
  look: 'grid' | 'chip';
  open: (file: File) => void;
  remove?: (() => void) | undefined;
}) {
  const url = useThumbnail(workspaceId, tableId, rowId, file);
  const [state, setState] = useState<'ready' | 'processing' | 'error'>('ready');
  return (
    <FileAttachment
      variant={look}
      file={{
        id: file.id,
        name: file.filename,
        mediaType: file.mediaType,
        size: formatFileSize(file.size),
        url,
        state,
      }}
      onOpen={() => {
        setState('processing');
        void loadFile(workspaceId, tableId, rowId, file).then(
          blob => {
            setState('ready');
            open(blob);
          },
          () => setState('error'),
        );
      }}
      onRetry={() => setState('ready')}
      onRemove={remove}
    />
  );
}

type Staged = {
  key: string;
  file: File;
  state: 'uploading' | 'ready' | 'error';
  saved?: RowAttachment;
  message?: string;
};

/** Files chosen, dropped or pasted, uploaded at once to the table so a description or comment can take them. */
export function useRowUploads(workspaceId: string, tableId: string, limit: number) {
  const api = rowAttachmentsApi(workspaceId, tableId);
  const [files, setFiles] = useState<Staged[]>([]);
  const [error, setError] = useState('');
  const controllers = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
    };
  }, []);
  const patch = (key: string, next: Partial<Staged>) =>
    setFiles(current => current.map(item => (item.key === key ? { ...item, ...next } : item)));
  async function upload(item: Staged) {
    const controller = new AbortController();
    controllers.current.set(item.key, controller);
    patch(item.key, { state: 'uploading' });
    try {
      const saved = await api.upload(item.file, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
      patch(item.key, { state: 'ready', saved });
      return saved;
    } catch (failure) {
      if (!controller.signal.aborted)
        patch(item.key, {
          state: 'error',
          message: failure instanceof TableRequestError ? failure.message : 'Upload failed. Retry this file.',
        });
      return null;
    } finally {
      controllers.current.delete(item.key);
    }
  }
  return {
    files,
    error,
    /** Adds files under the limit, counting `taken` files already saved. Resolves with the ones that uploaded. */
    add(picked: File[], taken = 0) {
      if (taken + files.length + picked.length > limit) {
        setError(`Attach at most ${limit} files.`);
        return Promise.resolve([]);
      }
      if (picked.some(file => file.size === 0 || file.size > maxBytes)) {
        setError('Choose nonempty files no larger than 100 MiB each.');
        return Promise.resolve([]);
      }
      setError('');
      const added = picked.map((file): Staged => ({ key: crypto.randomUUID(), file, state: 'uploading' }));
      setFiles(current => [...current, ...added]);
      return Promise.all(added.map(upload)).then(saved => saved.filter(item => item !== null));
    },
    retry: (item: Staged) => void upload(item),
    remove(key: string) {
      controllers.current.get(key)?.abort();
      setFiles(current => current.filter(item => item.key !== key));
    },
    /** Forgets uploads that a description or comment now holds. */
    drop: (ids: string[]) => setFiles(current => current.filter(item => !item.saved || !ids.includes(item.saved.id))),
    clear: () => {
      setFiles([]);
      setError('');
    },
    ids: () => files.flatMap(item => (item.saved ? [item.saved.id] : [])),
    ready: files.every(item => item.state === 'ready'),
  };
}
export type RowUploads = ReturnType<typeof useRowUploads>;

/** Pasted files from a clipboard event, or none when the paste is only text. */
export function pastedFiles(event: ClipboardEvent) {
  const files = [...event.clipboardData.files];
  if (files.length) event.preventDefault();
  return files;
}

/** Saved files of a description or comment, and files still uploading. Images show as thumbnails. */
export function RowFiles({
  workspaceId,
  tableId,
  rowId,
  saved,
  uploads,
  look = 'grid',
  remove,
}: {
  workspaceId: string;
  tableId: string;
  rowId: string | null;
  saved: readonly RowAttachment[];
  uploads?: RowUploads | undefined;
  look?: 'grid' | 'chip';
  remove?: ((id: string) => void) | undefined;
}) {
  const [viewing, setViewing] = useState<File | null>(null);
  const staged = uploads?.files ?? [];
  if (!saved.length && !staged.length && !uploads?.error) return null;
  return (
    <div className="space-y-2">
      <FileRenderersProvider renderers={fileRenderers}>
        <AttachmentGroup variant={look === 'grid' ? 'grid' : 'carousel'} aria-label="Attached files">
          {rowId &&
            saved.map(file => (
              <SavedFile
                key={file.id}
                workspaceId={workspaceId}
                tableId={tableId}
                rowId={rowId}
                file={file}
                look={look}
                open={setViewing}
                remove={remove && (() => remove(file.id))}
              />
            ))}
          {staged.map(item => (
            <FileAttachment
              key={item.key}
              variant={look}
              viewable
              preview
              file={{
                id: item.key,
                name: item.file.name,
                mediaType: item.file.type,
                size: formatFileSize(item.file.size),
                state: item.state,
                url: stagedPreview(item.file),
                source: { kind: 'local', file: item.file },
              }}
              onRemove={() => uploads?.remove(item.key)}
              onRetry={() => uploads?.retry(item)}
            />
          ))}
        </AttachmentGroup>
      </FileRenderersProvider>
      {staged.map(
        item =>
          item.state === 'error' && (
            <p key={item.key} role="alert" className="break-words text-sm text-destructive">
              {item.file.name}: {item.message}
            </p>
          ),
      )}
      {uploads?.error && (
        <p role="alert" className="text-sm text-destructive">
          {uploads.error}
        </p>
      )}
      <FileViewer
        file={viewing && { name: viewing.name, mediaType: viewing.type, source: { kind: 'local', file: viewing } }}
        open={!!viewing}
        onOpenChange={open => !open && setViewing(null)}
        renderers={fileRenderers}
      />
    </div>
  );
}

/** A paste into another field, such as the chat box, belongs to that field; the description's own box is ours. */
function typingIn(target: EventTarget | null) {
  if (!(target instanceof HTMLElement) || target.closest('[data-description-paste]')) return false;
  return target.closest('input, textarea, [contenteditable]') !== null;
}

/** The task description's files: thumbnails, an attach button, and paste or drop anywhere on the page. Saving binds each upload at once. */
export function DescriptionFiles({
  workspaceId,
  tableId,
  rowId,
  saved,
  editable,
  changed,
}: {
  workspaceId: string;
  tableId: string;
  rowId: string;
  saved: readonly RowAttachment[];
  editable: boolean;
  changed: () => Promise<void>;
}) {
  const uploads = useRowUploads(workspaceId, tableId, descriptionFileLimit);
  const [error, setError] = useState('');
  const api = rowAttachmentsApi(workspaceId, tableId);
  const save = async (change: { add?: string[]; remove?: string[] }) => {
    setError('');
    try {
      await api.changeDescription(rowId, change);
      await changed();
      return true;
    } catch (failure) {
      setError(failure instanceof TableRequestError ? failure.message : 'The files could not be saved. Try again.');
      return false;
    }
  };
  const add = async (files: File[]) => {
    const done = await uploads.add(files, saved.length);
    if (done.length && (await save({ add: done.map(file => file.id) }))) uploads.drop(done.map(file => file.id));
  };
  useEffect(() => {
    if (!editable) return;
    const onPaste = (event: globalThis.ClipboardEvent) => {
      if (event.defaultPrevented || typingIn(event.target)) return;
      const files = [...(event.clipboardData?.files ?? [])];
      if (!files.length) return;
      event.preventDefault();
      void add(files);
    };
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (event.defaultPrevented) return;
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.length) return;
      event.preventDefault();
      void add(files);
    };
    window.addEventListener('paste', onPaste);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  });
  const picker = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <RowFiles
        workspaceId={workspaceId}
        tableId={tableId}
        rowId={rowId}
        saved={saved}
        uploads={uploads}
        remove={editable ? id => void save({ remove: [id] }) : undefined}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {editable && saved.length < descriptionFileLimit && (
        <div>
          <Input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={event => {
              void add([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Attach files"
            title="Attach files, or paste or drop them anywhere"
            onClick={() => picker.current?.click()}
          >
            <PaperclipIcon aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}
