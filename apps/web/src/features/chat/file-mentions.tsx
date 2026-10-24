import type { Editor, Range } from '@tiptap/core';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import { FileAttachment, FileTypeIcon } from '@tulipfarm/sprout/attachment';
import { Button } from '@tulipfarm/sprout/button';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { ResultCard } from '@tulipfarm/sprout/result-card';
import { FileText } from 'reicon-react/icons/FileText';
import { MentionGroup, MentionList, MentionOption, MentionStatus } from '@tulipfarm/sprout/mention-list';
import { formatFileSize } from '@/lib/file-viewer';
import { useFeatureRead, useFeatureScope } from '@/lib/query';
import { fileKeys, fileUrl, useFilesApi, type FileSummary } from '@/features/files/api';
import {
  googleBlock,
  googleFilesApi,
  googleType,
  useDriveAccess,
  type GoogleBinding,
  type GoogleFileMetadata,
} from '@/features/files/google-api';
import { chatDocumentReferences, type ChatDocument } from '@tulipfarm/conversations/rich-content';
import type { RichTextEditorHandle } from '@tulipfarm/sprout/rich-text-editor';
import { useOptionalCanvas } from './canvas-state';
import {
  EditorSuggestionPanel,
  fileReferenceExtension,
  suggestionExtension,
  type EditorSuggestionState,
} from './editor-extensions';
import {
  addDraftFiles,
  readDraftFiles,
  referenceKey,
  referenceLimit,
  writeDraftFiles,
  type DraftTarget,
  type FileReference,
} from './draft-files';

type Search<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; items: T[] }
  | { kind: 'error' }
  | { kind: 'blocked' };
type Option =
  | { source: 'tulipfarm'; item: FileSummary }
  | { source: 'google'; item: GoogleFileMetadata; binding: GoogleBinding };

const resultLimit = 8;
const googleResultLimit = 5;
const localSearchDelayMs = 150;

function searchDelay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, localSearchDelayMs);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
/** Google types the chat can read as text. Folders, forms, and shortcuts have no readable content. */
export const googleReadable = (file: Pick<GoogleFileMetadata, 'name' | 'mimeType'>) =>
  ['pdf', 'sheet', 'blob'].includes(googleType(file).view);

/** The `@query` being typed at the caret, if any. `@` must start the text or follow whitespace. */
export function mentionAt(text: string, caret: number) {
  const match = /(?:^|\s)@([^\n@]{0,80})$/u.exec(text.slice(0, caret));
  const query = match?.[1];
  return query === undefined ? null : { start: caret - query.length - 1, end: caret, query };
}

export function useFileMentions(
  draft: DraftTarget,
  text: string,
  setText: (text: string) => void,
  input: RefObject<HTMLTextAreaElement | null>,
) {
  const scope = useFeatureScope();
  if (scope.kind !== 'workspace') throw new Error('File references require workspace membership admission.');
  const { workspaceId, membershipId } = scope;
  const api = useFilesApi(workspaceId);
  const listId = useId();
  const [references, setReferences] = useState<FileReference[]>(() =>
    readDraftFiles({ workspaceId, membershipId }, draft),
  );
  useEffect(() => {
    writeDraftFiles({ workspaceId, membershipId }, draft, references);
  }, [workspaceId, membershipId, draft, references]);
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [search, setSearch] = useState<Search<FileSummary>>({ kind: 'loading' });
  const [driveSearch, setDriveSearch] = useState<Search<GoogleFileMetadata>>({ kind: 'idle' });
  const [active, setActive] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const mention = caret === null ? null : mentionAt(text, caret);
  const open = mention !== null && mention.start !== dismissed;
  const query = open ? mention.query.trim() : null;
  const { access } = useDriveAccess(workspaceId, open);
  const drive = access.kind === 'ready' ? access : null;
  const google = useMemo(
    () => drive && { binding: drive.binding, api: googleFilesApi(workspaceId, drive.binding, drive.scopes) },
    [
      workspaceId,
      drive?.binding.integrationId,
      drive?.binding.accountId,
      drive?.binding.generation,
      drive?.scopes.join(' '),
    ],
  );

  useEffect(() => {
    if (query === null) return;
    const controller = new AbortController();
    setSearch(current => (current.kind === 'ready' ? current : { kind: 'loading' }));
    const timer = setTimeout(() => {
      api.search(query, controller.signal).then(
        items => {
          setSearch({
            kind: 'ready',
            items: items
              .filter(item => item.kind === 'file' && !item.trashed)
              .sort((left, right) => left.name.localeCompare(right.name)),
          });
          setActive(0);
        },
        () => {
          if (!controller.signal.aborted) setSearch({ kind: 'error' });
        },
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, query, attempt]);

  useEffect(() => {
    if (query === null || !google) return;
    if (!query) {
      setDriveSearch({ kind: 'idle' });
      return;
    }
    const controller = new AbortController();
    setDriveSearch(current => (current.kind === 'ready' ? current : { kind: 'loading' }));
    const timer = setTimeout(() => {
      google.api.list({ name: query, pageSize: 20 }, controller.signal).then(
        page => {
          setDriveSearch({ kind: 'ready', items: page.files.filter(googleReadable) });
          setActive(0);
        },
        error => {
          if (!controller.signal.aborted) setDriveSearch({ kind: googleBlock(error) ? 'blocked' : 'error' });
        },
      );
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [google, query, attempt]);

  const chosen = new Set(references.map(referenceKey));
  const files: Option[] =
    search.kind === 'ready'
      ? search.items
          .filter(item => !chosen.has(referenceKey({ source: 'tulipfarm', id: item.id })))
          .slice(0, resultLimit)
          .map(item => ({ source: 'tulipfarm', item }))
      : [];
  const driveFiles: Option[] =
    google && driveSearch.kind === 'ready'
      ? driveSearch.items
          .filter(item => !chosen.has(referenceKey({ source: 'google', id: item.id })))
          .slice(0, googleResultLimit)
          .map(item => ({ source: 'google', item, binding: google.binding }))
      : [];
  const options = [...files, ...driveFiles];
  const current = Math.min(active, Math.max(0, options.length - 1));
  const optionId = (index: number) => `${listId}-option-${index}`;

  function track(event: SyntheticEvent<HTMLTextAreaElement>) {
    const { selectionStart, selectionEnd, value } = event.currentTarget;
    const next = selectionStart === selectionEnd ? selectionStart : null;
    setCaret(next);
    if (next === null || !mentionAt(value, next)) setDismissed(null);
  }

  function select(option: Option) {
    if (!mention) return;
    if (references.length >= referenceLimit) {
      setNotice(`Add up to ${referenceLimit} files per message. Remove one to add another.`);
      return;
    }
    const added: FileReference =
      option.source === 'tulipfarm'
        ? {
            source: 'tulipfarm',
            id: option.item.id,
            name: option.item.name,
            mediaType: option.item.mediaType ?? '',
            size: option.item.size,
          }
        : {
            source: 'google',
            id: option.item.id,
            name: option.item.name,
            mediaType: option.item.mimeType,
            binding: option.binding,
          };
    setReferences(list => [...list, added]);
    setNotice(null);
    setText(text.slice(0, mention.start) + text.slice(mention.end));
    setCaret(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(mention.start, mention.start);
    });
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open || !mention || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed(mention.start);
      return;
    }
    if (search.kind === 'error' && event.key === 'Enter') {
      event.preventDefault();
      setAttempt(value => value + 1);
      return;
    }
    if (!options.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
    } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      const item = options[current];
      if (!item) return;
      event.preventDefault();
      select(item);
    }
  }

  const retry = { label: 'Retry search', onAction: () => setAttempt(value => value + 1) };
  const status =
    search.kind === 'loading' ? (
      <MentionStatus tone="loading">Searching your files…</MentionStatus>
    ) : search.kind === 'error' ? (
      <MentionStatus tone="error" action={retry}>
        Couldn’t search Files. Check your connection, then retry.
      </MentionStatus>
    ) : search.kind !== 'ready' || files.length ? undefined : (
      <MentionStatus tone="empty">
        {search.items.length
          ? 'Every matching file is already added.'
          : query
            ? `No files you can open match “${query}”.`
            : 'No files yet. Upload one in Files to use it here.'}
      </MentionStatus>
    );
  const driveStatus = !google ? undefined : driveSearch.kind === 'idle' ? (
    <MentionStatus tone="empty">Type a name to search your Google Drive.</MentionStatus>
  ) : driveSearch.kind === 'loading' ? (
    <MentionStatus tone="loading">Searching Google Drive…</MentionStatus>
  ) : driveSearch.kind === 'blocked' ? (
    <MentionStatus tone="error">
      Google Drive needs reconnecting. Reconnect it in Integrations to add Drive files.
    </MentionStatus>
  ) : driveSearch.kind === 'error' ? (
    search.kind === 'error' ? (
      <MentionStatus tone="error">Couldn’t search Google Drive. Google didn’t respond.</MentionStatus>
    ) : (
      <MentionStatus tone="error" action={{ label: 'Retry Drive search', onAction: retry.onAction }}>
        Couldn’t search Google Drive. Google didn’t respond.
      </MentionStatus>
    )
  ) : driveFiles.length ? undefined : (
    <MentionStatus tone="empty">
      {driveSearch.items.length
        ? 'Every matching Drive file is already added.'
        : `No Google Drive files you can read match “${query}”.`}
    </MentionStatus>
  );
  const option = (entry: Option, index: number) => (
    <MentionOption
      key={referenceKey({ source: entry.source, id: entry.item.id })}
      id={optionId(index)}
      active={index === current}
      onSelect={() => select(entry)}
      title={entry.item.name}
      media={
        entry.source === 'tulipfarm' ? (
          <FileTypeIcon name={entry.item.name} mediaType={entry.item.mediaType ?? ''} />
        ) : (
          <GoogleMentionIcon file={entry.item} />
        )
      }
      description={
        entry.source === 'google'
          ? googleType(entry.item).label
          : entry.item.size === null
            ? undefined
            : formatFileSize(entry.item.size)
      }
    />
  );
  return {
    references,
    notice,
    remove: (reference: FileReference) => {
      setReferences(list => list.filter(entry => referenceKey(entry) !== referenceKey(reference)));
      setNotice(null);
    },
    clear: () => {
      setReferences([]);
      setNotice(null);
    },
    /** Moves Google Drive references to the new private chat draft. Returns false when that draft has no room. */
    moveGoogleToNewChat: () => {
      const moving = references.filter(reference => reference.source === 'google');
      if (!addDraftFiles({ workspaceId, membershipId }, 'new', moving)) {
        setNotice(
          `Your new chat draft already has files. A message can reference up to ${referenceLimit}. Remove some there first.`,
        );
        return false;
      }
      setReferences(list => list.filter(reference => reference.source !== 'google'));
      return true;
    },
    /**
     * The message box keeps its textbox role (a textarea takes no combobox role), so it reports the list's state
     * through `aria-expanded` and names the list only while it is open.
     */
    input: {
      'aria-expanded': open,
      'aria-autocomplete': 'list' as const,
      'aria-controls': open ? listId : undefined,
      'aria-activedescendant': open && options.length ? optionId(current) : undefined,
      onKeyDown,
      onSelect: track,
      onBlur: (event: FocusEvent<HTMLTextAreaElement>) => {
        if (!event.currentTarget.form?.contains(event.relatedTarget)) setCaret(null);
      },
    },
    panel: open ? (
      <MentionList
        id={listId}
        label="Files you can add"
        status={
          status || driveStatus ? (
            <>
              {status}
              {driveStatus}
            </>
          ) : undefined
        }
        announcement={
          options.length
            ? `${options.length} ${options.length === 1 ? 'file' : 'files'} you can add. Use Up and Down to choose, Enter to add, Escape to close.`
            : undefined
        }
      >
        {google ? (
          <>
            {files.length > 0 && <MentionGroup label="Files">{files.map(option)}</MentionGroup>}
            {driveFiles.length > 0 && (
              <MentionGroup label="Google Drive">
                {driveFiles.map((entry, index) => option(entry, files.length + index))}
              </MentionGroup>
            )}
          </>
        ) : (
          files.map(option)
        )}
      </MentionList>
    ) : null,
  };
}

export function useRichFileMentions(
  draft: DraftTarget,
  content: ChatDocument | null,
  input: RefObject<RichTextEditorHandle | null>,
) {
  const scope = useFeatureScope();
  if (scope.kind !== 'workspace') throw new Error('File references require workspace membership admission.');
  const { workspaceId, membershipId } = scope;
  const api = useFilesApi(workspaceId);
  const [references, setReferences] = useState<FileReference[]>(() =>
    readDraftFiles({ workspaceId, membershipId }, draft),
  );
  const [restored] = useState(references);
  const [suggestion, setSuggestion] = useState<EditorSuggestionState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const initialized = useRef(false);
  const { access } = useDriveAccess(workspaceId, true);
  const drive = access.kind === 'ready' ? access : null;
  const google = useMemo(
    () => drive && { binding: drive.binding, api: googleFilesApi(workspaceId, drive.binding, drive.scopes) },
    [
      workspaceId,
      drive?.binding.integrationId,
      drive?.binding.accountId,
      drive?.binding.generation,
      drive?.scopes.join(' '),
    ],
  );
  const referencesRef = useRef(references);
  const googleRef = useRef(google);
  referencesRef.current = references;
  googleRef.current = google;

  useEffect(() => {
    writeDraftFiles({ workspaceId, membershipId }, draft, references);
  }, [workspaceId, membershipId, draft, references]);
  useEffect(() => {
    if (!content) return;
    const documentReferences = chatDocumentReferences(content);
    if (!initialized.current && !documentReferences.length) return;
    initialized.current = true;
    const keys = new Set(documentReferences.map(referenceKey));
    // Each parse yields a new document, so keep the same array when nothing was removed or this effect re-renders forever.
    setReferences(current =>
      current.every(reference => keys.has(referenceKey(reference)))
        ? current
        : current.filter(reference => keys.has(referenceKey(reference))),
    );
  }, [content]);
  useEffect(() => {
    if (!content) return;
    const editor = input.current?.editor();
    if (!editor || initialized.current || !restored.length || chatDocumentReferences(content).length) return;
    initialized.current = true;
    editor
      .chain()
      .focus('end')
      .insertContent(
        restored.flatMap(reference => [
          { type: 'fileReference', attrs: { source: reference.source, id: reference.id } },
          { type: 'text', text: ' ' },
        ]),
      )
      .run();
  }, [content, input, restored]);

  const fileNode = useMemo(
    () =>
      fileReferenceExtension((source, id) => {
        const reference = referencesRef.current.find(item => item.source === source && item.id === id);
        return reference ? { name: reference.name, mediaType: reference.mediaType } : null;
      }),
    [],
  );
  const suggestionExtensionValue = useMemo(
    () =>
      suggestionExtension({
        key: 'file',
        char: '@',
        label: 'Files you can add',
        allowSpaces: true,
        items: async (query, signal) => {
          const search = query.trim();
          if (search) await searchDelay(signal);
          const local = await api.suggestions(search, signal);
          const currentGoogle = googleRef.current;
          const currentReferences = referencesRef.current;
          const driveFiles =
            currentGoogle && search
              ? (await currentGoogle.api.list({ name: search, pageSize: 5 }, signal)).files
                  .filter(googleReadable)
                  .slice(0, googleResultLimit)
              : [];
          return [
            ...local.items.map(item => ({
              id: `tulipfarm:${item.id}`,
              title: item.name,
              ...(item.size === null ? {} : { description: formatFileSize(item.size) }),
              media: <FileTypeIcon name={item.name} mediaType={item.mediaType ?? ''} />,
              apply: (editor: Editor, range: Range) => {
                if (currentReferences.some(reference => reference.source === 'tulipfarm' && reference.id === item.id)) {
                  editor.chain().focus().deleteRange(range).run();
                  return;
                }
                if (currentReferences.length >= referenceLimit) {
                  setNotice(`Add up to ${referenceLimit} files per message. Remove one to add another.`);
                  return;
                }
                setReferences(current => [
                  ...current,
                  {
                    source: 'tulipfarm',
                    id: item.id,
                    name: item.name,
                    mediaType: item.mediaType ?? '',
                    size: item.size,
                  },
                ]);
                editor
                  .chain()
                  .focus()
                  .insertContentAt(range, [
                    { type: 'fileReference', attrs: { source: 'tulipfarm', id: item.id } },
                    { type: 'text', text: ' ' },
                  ])
                  .run();
              },
            })),
            ...driveFiles.map(item => ({
              id: `google:${item.id}`,
              title: item.name,
              description: googleType(item).label,
              media: <GoogleMentionIcon file={item} />,
              apply: (editor: Editor, range: Range) => {
                if (
                  !currentGoogle ||
                  currentReferences.some(reference => reference.source === 'google' && reference.id === item.id)
                ) {
                  editor.chain().focus().deleteRange(range).run();
                  return;
                }
                if (currentReferences.length >= referenceLimit) {
                  setNotice(`Add up to ${referenceLimit} files per message. Remove one to add another.`);
                  return;
                }
                setReferences(current => [
                  ...current,
                  {
                    source: 'google',
                    id: item.id,
                    name: item.name,
                    mediaType: item.mimeType,
                    binding: currentGoogle.binding,
                  },
                ]);
                editor
                  .chain()
                  .focus()
                  .insertContentAt(range, [
                    { type: 'fileReference', attrs: { source: 'google', id: item.id } },
                    { type: 'text', text: ' ' },
                  ])
                  .run();
              },
            })),
          ];
        },
        onState: setSuggestion,
      }),
    [api],
  );
  const extensions = useMemo(() => [fileNode, suggestionExtensionValue], [fileNode, suggestionExtensionValue]);

  const deleteReference = (reference: FileReference) =>
    input.current
      ?.editor()
      ?.chain()
      .focus()
      .command(({ tr, state }) => {
        state.doc.descendants((node, position) => {
          if (
            node.type.name === 'fileReference' &&
            node.attrs.source === reference.source &&
            node.attrs.id === reference.id
          )
            tr.delete(position, position + node.nodeSize);
        });
        return true;
      })
      .run();

  return {
    references,
    notice,
    extensions,
    suggestion,
    panel: suggestion ? <EditorSuggestionPanel state={suggestion} empty="No files you can open match." /> : null,
    /**
     * Records references whose chips the caller adds to the document itself. Returns the ones that were new, or null,
     * changing nothing, when the message would exceed the reference limit.
     */
    attach: (added: readonly FileReference[]) => {
      const current = referencesRef.current;
      const fresh = added.filter(file => !current.some(entry => referenceKey(entry) === referenceKey(file)));
      if (current.length + fresh.length > referenceLimit) {
        setNotice(`Add up to ${referenceLimit} files per message. Remove one to add another.`);
        return null;
      }
      referencesRef.current = [...current, ...fresh];
      setReferences(referencesRef.current);
      return fresh;
    },
    remove: (reference: FileReference) => {
      deleteReference(reference);
      setReferences(current => current.filter(item => referenceKey(item) !== referenceKey(reference)));
      setNotice(null);
    },
    clear: () => {
      setReferences([]);
      setNotice(null);
      initialized.current = true;
    },
    typeTrigger: () => {
      const editor = input.current?.editor();
      if (!editor) return;
      const { from } = editor.state.selection;
      const before = editor.state.doc.textBetween(Math.max(0, from - 1), from, '\n', '\n');
      editor
        .chain()
        .focus()
        .insertContent(before && !/\s/.test(before) ? ' @' : '@')
        .run();
    },
    moveGoogleToNewChat: () => {
      const moving = references.filter(reference => reference.source === 'google');
      if (!addDraftFiles({ workspaceId, membershipId }, 'new', moving)) {
        setNotice(
          `Your new chat draft already has files. A message can reference up to ${referenceLimit}. Remove some there first.`,
        );
        return false;
      }
      for (const reference of moving) deleteReference(reference);
      setReferences(current => current.filter(reference => reference.source !== 'google'));
      return true;
    },
  };
}

function GoogleMentionIcon({ file }: { file: Pick<GoogleFileMetadata, 'name' | 'mimeType'> }) {
  const brand = googleType(file).brand;
  return brand ? <BrandIcon brand={brand} size="glyph" /> : <FileTypeIcon name={file.name} mediaType={file.mimeType} />;
}

/** A sent Google Drive reference. Its name was recorded when it was sent; opening it reads the file live under the viewer's current Google access. */
export function ConversationGoogleFileReference({
  slug,
  fileId,
  name,
  mimeType,
}: {
  slug: string;
  fileId: string;
  name: string;
  mimeType: string;
}) {
  const canvas = useOptionalCanvas();
  const scope = useFeatureScope();
  return (
    <FileAttachment
      variant="chip"
      file={{ id: fileId, name, mediaType: mimeType, size: 'Google Drive', state: 'ready' }}
      onOpen={() =>
        canvas && scope.kind === 'workspace'
          ? canvas.show({
              id: `google-file:${fileId}`,
              title: name,
              content: { kind: 'google-file', workspaceId: scope.workspaceId, fileId },
            })
          : window.open(`/${encodeURIComponent(slug)}/files/google/${encodeURIComponent(fileId)}`, '_blank', 'noopener')
      }
    />
  );
}

/** A sent reference or a file the reply created. The name loads under the viewer's own access; a file they can't open stays nameless. */
export function ConversationFileReference({
  workspaceId,
  slug,
  fileId,
  created = false,
}: {
  workspaceId: string;
  slug: string;
  fileId: string;
  created?: boolean;
}) {
  const api = useFilesApi(workspaceId);
  const canvas = useOptionalCanvas();
  const read = useFeatureRead({ key: fileKeys.item(fileId), load: signal => api.read(fileId, signal) });
  if (read.state.kind === 'loading')
    return (
      <FileAttachment
        variant="chip"
        file={{ id: fileId, name: 'Loading file…', mediaType: '', size: '', state: 'processing' }}
        onOpen={() => undefined}
      />
    );
  if (read.state.kind === 'unavailable')
    return (
      <p className={`${created ? 'self-start' : 'self-end'} text-sm text-muted-foreground`}>
        {created ? 'A file created in this reply is unavailable to you.' : 'A referenced file is unavailable to you.'}
      </p>
    );
  if (read.state.kind === 'error')
    return (
      <div className={`flex flex-wrap items-center gap-2 ${created ? 'self-start' : 'justify-end self-end'}`}>
        <p role="alert" className="text-sm text-muted-foreground">
          Couldn’t load file details.
        </p>
        <Button size="sm" variant="outline" onClick={() => void read.refresh()}>
          Retry file details
        </Button>
      </div>
    );
  const file = read.state.data;
  const open = () =>
    canvas && file.kind === 'file'
      ? canvas.show({
          id: `file:${file.id}`,
          title: file.name,
          content: {
            kind: 'workspace-file',
            workspaceId,
            fileId: file.id,
            name: file.name,
            mediaType: file.mediaType ?? '',
          },
        })
      : window.open(fileUrl(slug, file), '_blank', 'noopener');
  const chip = (
    <FileAttachment
      variant="chip"
      file={{
        id: file.id,
        name: file.name,
        mediaType: file.mediaType ?? '',
        size: created ? 'Saved in Files' : 'File reference',
        state: 'ready',
      }}
      onOpen={open}
    />
  );
  return created ? (
    <ResultCard
      title={file.name}
      kind="File"
      apps={[]}
      icon={<FileText size={18} />}
      status="Saved in Files"
      state="success"
      action={{ label: 'View file', onClick: open }}
    />
  ) : (
    chip
  );
}

export function openFileReference(slug: string, reference: FileReference) {
  const url =
    reference.source === 'tulipfarm'
      ? fileUrl(slug, { id: reference.id, kind: 'file' })
      : `/${encodeURIComponent(slug)}/files/google/${encodeURIComponent(reference.id)}`;
  window.open(url, '_blank', 'noopener');
}
