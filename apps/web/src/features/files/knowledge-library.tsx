import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { knowledgeSaveSchema, type KnowledgeSave } from '@tulipfarm/knowledge/contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Textarea } from '@tulipfarm/sprout/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { KnowledgeCitation } from '@/features/chat/knowledge-citation';
import { CommandFeedback, ReadResult, useCommand, useExpired } from '@/features/integrations/slack-knowledge-shared';
import { AddToKnowledgeDialog } from './add-to-knowledge';
import { filesApi, type FileSummary } from './api';
import { knowledgeApi, personalKnowledgeKeys, type KnowledgeEntry } from './knowledge-api';

type Api = ReturnType<typeof knowledgeApi>;
const labels = {
  queued: 'Queued',
  parsing: 'Parsing',
  ready: 'Ready',
  failed: 'Failed',
  'ocr-unavailable': 'OCR unavailable',
};

function EntryEditor({
  api,
  entry,
  onClose,
  onSaved,
}: {
  api: Api;
  entry: KnowledgeEntry | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const original = useFeatureRead({
    key: [...personalKnowledgeKeys, 'entry', entry?.documentId],
    load: signal => api.get(entry!.documentId, signal),
    enabled: entry !== null,
    staleTime: 0,
  });
  if (entry)
    return (
      <ReadResult state={original.state} label="entry" retry={original.refresh}>
        {current => (
          <EntryForm key={current.revisionId} api={api} entry={current} onClose={onClose} onSaved={onSaved} />
        )}
      </ReadResult>
    );
  return <EntryForm api={api} entry={null} onClose={onClose} onSaved={onSaved} />;
}

function EntryForm({
  api,
  entry,
  onClose,
  onSaved,
}: {
  api: Api;
  entry: KnowledgeEntry | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(entry?.title ?? '');
  const [text, setText] = useState(entry?.noteText ?? '');
  const [errors, setErrors] = useState<{ title?: string; text?: string }>({});
  const command = useCommand(
    (input: KnowledgeSave, signal) => api.save(input, signal),
    async () => {
      await onSaved();
      onClose();
    },
    [personalKnowledgeKeys],
  );
  const note = !entry || entry.kind === 'note';
  return (
    <form
      aria-label={entry ? 'Edit Knowledge entry' : 'Add Knowledge note'}
      noValidate
      onSubmit={event => {
        event.preventDefault();
        const input = {
          commandId: crypto.randomUUID(),
          documentId: entry?.documentId ?? crypto.randomUUID(),
          expectedRevisionId: entry?.revisionId ?? null,
          title,
          input: note ? { kind: 'note', text } : { kind: 'file', fileId: entry?.fileId },
        };
        const parsed = knowledgeSaveSchema.safeParse(input);
        if (!parsed.success) {
          setErrors({
            ...(parsed.error.issues.some(issue => issue.path[0] === 'title')
              ? { title: 'Enter a title with 1 to 512 valid characters.' }
              : {}),
            ...(note && parsed.error.issues.some(issue => issue.path[0] === 'input')
              ? { text: 'Enter nonempty note text, up to 10 MiB, with valid characters.' }
              : {}),
          });
          return;
        }
        setErrors({});
        void command.send(parsed.data);
      }}
      className="space-y-4"
    >
      <CommandFeedback state={command.state} retry={command.retry} />
      <div className="space-y-2">
        <Label htmlFor="knowledge-title">Title</Label>
        <Input
          id="knowledge-title"
          value={title}
          maxLength={512}
          disabled={command.locked}
          aria-invalid={!!errors.title}
          aria-describedby={errors.title ? 'knowledge-title-error' : undefined}
          onChange={event => setTitle(event.target.value)}
        />
        {errors.title && (
          <p id="knowledge-title-error" role="alert">
            {errors.title}
          </p>
        )}
      </div>
      {note && (
        <div className="space-y-2">
          <Label htmlFor="knowledge-text">Note text</Label>
          <Textarea
            id="knowledge-text"
            value={text}
            disabled={command.locked}
            aria-invalid={!!errors.text}
            aria-describedby={errors.text ? 'knowledge-text-error' : undefined}
            onChange={event => setText(event.target.value)}
          />
          {errors.text && (
            <p id="knowledge-text-error" role="alert">
              {errors.text}
            </p>
          )}
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={command.locked} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={command.locked}>
          {entry ? 'Save changes' : 'Add note'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RemoveEntry({
  api,
  entry,
  onClose,
  onRemoved,
}: {
  api: Api;
  entry: KnowledgeEntry;
  onClose: () => void;
  onRemoved: () => Promise<void>;
}) {
  const command = useCommand(
    (commandId: string, signal) => api.remove(entry, commandId, signal),
    async () => {
      await onRemoved();
      onClose();
    },
    [personalKnowledgeKeys],
  );
  return (
    <>
      <CommandFeedback state={command.state} retry={command.retry} />
      <DialogFooter>
        <Button variant="outline" disabled={command.locked} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={command.locked} onClick={() => void command.send(crypto.randomUUID())}>
          Remove entry
        </Button>
      </DialogFooter>
    </>
  );
}

function FilePicker({ workspaceId, onSelect }: { workspaceId: string; onSelect: (file: FileSummary) => void }) {
  const api = useMemo(() => filesApi(workspaceId), [workspaceId]);
  const [query, setQuery] = useState('');
  const [after, setAfter] = useState<string>();
  const read = useFeatureRead({
    key: ['files', 'knowledge-picker', query, after],
    load: signal => api.suggestions(query, signal, after),
  });
  return (
    <div className="space-y-4">
      <Label htmlFor="knowledge-file-query">Find a file</Label>
      <Input
        id="knowledge-file-query"
        maxLength={255}
        value={query}
        onChange={event => {
          setQuery(event.target.value);
          setAfter(undefined);
        }}
      />
      <ReadResult state={read.state} label="files" retry={read.refresh}>
        {data => (
          <>
            {data.items.length ? (
              <ul aria-label="Files to add" className="space-y-2">
                {data.items
                  .filter(file => file.kind === 'file')
                  .map(file => (
                    <li key={file.id}>
                      <Button variant="outline" onClick={() => onSelect(file)}>
                        {file.name}
                      </Button>
                    </li>
                  ))}
              </ul>
            ) : (
              <p>No matching files. Upload a file in Files first.</p>
            )}
            {data.next && (
              <Button variant="outline" onClick={() => setAfter(data.next!)}>
                More files
              </Button>
            )}
          </>
        )}
      </ReadResult>
    </div>
  );
}

function SearchResults({ api, query }: { api: Api; query: string }) {
  const read = useFeatureRead({
    key: [...personalKnowledgeKeys, 'search', query],
    load: signal => api.search(query, signal),
    staleTime: 0,
  });
  const result = read.state.kind === 'ready' ? read.state.data : null;
  const expired = useExpired(result?.validUntil);
  if (expired)
    return (
      <Button variant="outline" onClick={() => void read.refresh()}>
        Refresh search results
      </Button>
    );
  return (
    <ReadResult state={read.state} label="search results" retry={read.refresh}>
      {data => (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Keyword results from your Knowledge.</p>
          {!data.hits.length && <p>No matching passages.</p>}
          <ul aria-label="Matching passages" className="space-y-4">
            {data.hits.map(hit => (
              <li key={`${hit.citation.publicationId}:${hit.citation.ordinal}`} className="rounded-lg border p-4">
                <KnowledgeCitation
                  workspaceId={hit.citation.workspaceId}
                  citationId={`${hit.citation.publicationId}:${hit.citation.ordinal}`}
                >
                  {hit.title}
                </KnowledgeCitation>
                <p className="text-sm text-muted-foreground">
                  {[
                    hit.heading,
                    hit.location &&
                      (hit.location.kind === 'sheet'
                        ? `Sheet ${hit.location.sheet}: ${hit.location.name}`
                        : hit.location.kind === 'page'
                          ? `Page ${hit.location.page}`
                          : `Slide ${hit.location.slide}`),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <p className="whitespace-pre-wrap">{hit.text}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ReadResult>
  );
}

export function KnowledgeLibrary({
  workspaceId,
  slug,
  entries,
  refresh,
}: {
  workspaceId: string;
  slug: string;
  entries: KnowledgeEntry[];
  refresh: () => Promise<void>;
}) {
  const api = useMemo(() => knowledgeApi(workspaceId), [workspaceId]);
  const navigate = useNavigate();
  const { change } = useFeatureChanges();
  const [editor, setEditor] = useState<{ entry: KnowledgeEntry | null } | null>(null);
  const [removing, setRemoving] = useState<KnowledgeEntry | null>(null);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<FileSummary | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const changed = () => change({ kind: 'conceal', keys: [personalKnowledgeKeys] });
  const retry = useCommand(
    ({ entry, commandId }: { entry: KnowledgeEntry; commandId: string }, signal) => api.retry(entry, commandId, signal),
    changed,
    [personalKnowledgeKeys],
  );
  return (
    <section aria-label="Your Knowledge" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">Your entries</h2>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditor({ entry: null })}>Add note</Button>
          <Button variant="outline" onClick={() => setPicking(true)}>
            Add from Files
          </Button>
          <Button
            variant="outline"
            onClick={() => void navigate({ to: '/$workspaceSlug/files', params: { workspaceSlug: slug } })}
          >
            Upload files
          </Button>
          <Button
            variant="outline"
            onClick={() => void navigate({ to: '/$workspaceSlug/integrations', params: { workspaceSlug: slug } })}
          >
            Connect a source
          </Button>
        </div>
      </div>
      <form
        role="search"
        aria-label="Search your Knowledge"
        onSubmit={event => {
          event.preventDefault();
          setSearch(query.trim());
        }}
        className="flex gap-2"
      >
        <Input
          type="search"
          aria-label="Search Knowledge"
          placeholder="Search Knowledge by keyword"
          maxLength={512}
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            if (!event.target.value.trim()) setSearch('');
          }}
        />
        <Button type="submit" variant="outline" disabled={!query.trim()}>
          Search
        </Button>
      </form>
      <CommandFeedback state={retry.state} retry={retry.retry} />
      {search ? (
        <SearchResults api={api} query={search} />
      ) : entries.length ? (
        <ul aria-label="Knowledge entries" className="divide-y rounded-lg border">
          {entries.map(entry => (
            <li key={entry.documentId} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <h3 className="break-words font-medium">{entry.title}</h3>
                <p className="text-sm text-muted-foreground">
                  {entry.kind === 'note' ? 'Note' : 'File'} · <span role="status">{labels[entry.parsing]}</span>
                </p>
                {entry.failure && <p className="text-sm text-destructive">Reason: {entry.failure}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {entry.canRetry && entry.parsing === 'failed' && (
                  <Button
                    variant="outline"
                    disabled={retry.locked}
                    onClick={() => void retry.send({ entry, commandId: crypto.randomUUID() })}
                  >
                    Retry
                  </Button>
                )}
                <Button variant="outline" aria-label={`Edit ${entry.title}`} onClick={() => setEditor({ entry })}>
                  {entry.kind === 'note' ? 'Edit note' : 'Retitle'}
                </Button>
                <Button variant="outline" aria-label={`Remove ${entry.title}`} onClick={() => setRemoving(entry)}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <StatePanel
          kind="empty"
          heading="h3"
          title="No personal entries yet"
          description="Add a note, add a file from Files, upload files, or connect a source using the actions above."
        />
      )}
      <Button variant="ghost" onClick={() => void refresh()}>
        Refresh entries
      </Button>
      {editor && (
        <Dialog
          open
          onOpenChange={open => {
            if (!open) setEditor(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editor.entry ? 'Edit Knowledge entry' : 'Add a note'}</DialogTitle>
              <DialogDescription>Notes belong to you. Changes queue a new revision for parsing.</DialogDescription>
            </DialogHeader>
            <EntryEditor api={api} entry={editor.entry} onClose={() => setEditor(null)} onSaved={changed} />
          </DialogContent>
        </Dialog>
      )}
      {removing && (
        <Dialog
          open
          onOpenChange={open => {
            if (!open) setRemoving(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove {removing.title}?</DialogTitle>
              <DialogDescription>
                This removes the Knowledge entry. The original in Files is not deleted.
              </DialogDescription>
            </DialogHeader>
            <RemoveEntry api={api} entry={removing} onClose={() => setRemoving(null)} onRemoved={changed} />
          </DialogContent>
        </Dialog>
      )}
      {picking && (
        <Dialog open onOpenChange={setPicking}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add a file from Files</DialogTitle>
              <DialogDescription>Choose a file you can read to add to your Knowledge.</DialogDescription>
            </DialogHeader>
            <FilePicker
              workspaceId={workspaceId}
              onSelect={file => {
                setPicking(false);
                setSelected(file);
              }}
            />
          </DialogContent>
        </Dialog>
      )}
      {selected && (
        <AddToKnowledgeDialog
          workspaceId={workspaceId}
          items={[selected]}
          onClose={() => {
            setSelected(null);
            void changed();
          }}
        />
      )}
    </section>
  );
}
