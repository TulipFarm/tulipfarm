import { useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFlag } from '@/lib/feature-flags';
import { useFeatureRead, useFeatureScope } from '@/lib/query';
import {
  GoogleKnowledgeError,
  googleConcealKeys,
  googleCorpusKindSchema,
  googleCorpusSelectionSchema,
  googleErrorMessages,
  googleSourceKeys,
  type ConfigureGoogle,
  type GoogleKind,
  type GoogleKnowledgeApi,
  type GoogleSource,
} from './google-knowledge-api';
import { CommandFeedback, ReadResult, useCommand } from './slack-knowledge-shared';

const day = 86_400_000;
const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);
const kindLabels: Record<GoogleKind, string> = {
  'drive-folder': 'My Drive or a folder',
  'shared-drive': 'Shared drive',
  'drive-all': 'All Drive files',
  gmail: 'Gmail',
};

export function GoogleSelectionForm({
  api,
  kinds,
  onSaved,
  onClose,
}: {
  api: GoogleKnowledgeApi;
  kinds: readonly GoogleKind[];
  onSaved: (source: GoogleSource) => Promise<void>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<GoogleKind>(kinds[0] ?? 'drive-folder');
  const [selected, setSelected] = useState<{ id: string; title: string } | null>(null);
  const [after, setAfter] = useState(() => isoDate(Date.now() - 90 * day));
  const [before, setBefore] = useState(() => isoDate(Date.now() + day));
  const [shared, setShared] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const scope = useFeatureScope();
  const discovery = useFeatureRead({
    key: [...googleSourceKeys, 'discover', kind, cursor],
    staleTime: 0,
    load: signal =>
      api.discover(kind, cursor, signal).then(
        data => ({ ...data, blocked: null }),
        (error: unknown) => {
          const message = error instanceof GoogleKnowledgeError ? googleErrorMessages[error.code] : undefined;
          if (message) return { binding: null, items: [], nextCursor: null, blocked: message };
          throw error;
        },
      ),
  });
  const members = useFeatureRead({
    key: [...googleSourceKeys, 'members'],
    load: api.members,
    enabled: shared && kind !== 'gmail',
  });
  const command = useCommand<ConfigureGoogle, GoogleSource>(
    (input, signal) => api.configure(input, signal),
    onSaved,
    googleConcealKeys,
  );
  const selection = googleCorpusSelectionSchema.safeParse(
    kind === 'gmail'
      ? { kind, labelId: selected?.id === 'bounded-mailbox' ? null : selected?.id, after, before }
      : kind === 'drive-folder'
        ? { kind, folderId: selected?.id }
        : { kind, driveId: selected?.id },
  );
  const dateInvalid = kind === 'gmail' && !selection.success && !!selected;
  const candidates =
    members.state.kind === 'ready'
      ? members.state.data.members.filter(member => scope.kind !== 'workspace' || member.id !== scope.membershipId)
      : [];
  const visible = candidates.filter(member =>
    `${member.name} ${member.email}`.toLowerCase().includes(search.toLowerCase()),
  );
  const audienceReady =
    !shared ||
    (members.state.kind === 'ready' &&
      !members.state.error &&
      memberIds.length > 0 &&
      memberIds.every(id => candidates.some(member => member.id === id)));
  const discoveryReady = discovery.state.kind === 'ready' && !discovery.state.error && !discovery.state.data.blocked;
  const busy = command.state.kind === 'sending';
  const choiceLabel = kind === 'gmail' ? 'Gmail scope' : kind === 'shared-drive' ? 'Shared drive' : 'Folder';
  const automatic = useFlag('default-connection-knowledge');
  return (
    <section aria-label="Select Google source" className="space-y-4 border-t pt-4">
      <h4 className="text-base font-medium">Select Google source</h4>
      <p className="text-sm text-muted-foreground">
        {kind === 'gmail'
          ? 'Choose a label or your whole mailbox within a date range. Gmail stays private to you.'
          : `Choose My Drive to index all your files, or one folder or shared drive. ${automatic ? 'New Drive integrations also import automatically; see Automatic Knowledge.' : 'Connecting Google does not import anything until you save a source.'}`}
      </p>
      <form
        noValidate
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          setAttempted(true);
          if (command.locked || !selection.success || !audienceReady || !discoveryReady) return;
          void command.send({
            commandId: crypto.randomUUID(),
            selection: selection.data,
            memberIds: kind === 'gmail' || !shared ? [] : memberIds,
          });
        }}
      >
        <fieldset disabled={command.locked} className="min-w-0 space-y-4">
          {kinds.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="google-source-kind">Source type</Label>
              <Select
                value={kind}
                onValueChange={value => {
                  const result = googleCorpusKindSchema.safeParse(value);
                  if (result.success && kinds.includes(result.data)) {
                    setKind(result.data);
                    setSelected(null);
                    setCursors([null]);
                    setAttempted(false);
                    if (result.data === 'gmail') {
                      setShared(false);
                      setMemberIds([]);
                    }
                  }
                }}
              >
                <SelectTrigger id="google-source-kind" width="full">
                  <SelectValue>{kindLabels[kind]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {kinds.map(value => (
                    <SelectItem key={value} value={value}>
                      {kindLabels[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <ReadResult state={discovery.state} retry={discovery.refresh} label="Google choices">
            {data =>
              data.blocked ? (
                <StatePanel
                  kind="unavailable"
                  heading="h3"
                  title="Google choices unavailable"
                  description={data.blocked}
                >
                  <Button variant="outline" onClick={() => void discovery.refresh()}>
                    Check Google again
                  </Button>
                </StatePanel>
              ) : (
                <div className="space-y-3">
                  {data.items.length === 0 && kind !== 'gmail' ? (
                    <StatePanel
                      kind="empty"
                      heading="h3"
                      title="No Google choices on this page"
                      description="Choose another source type or check Google access before trying again."
                    >
                      <Button variant="outline" onClick={() => void discovery.refresh()}>
                        Check Google choices again
                      </Button>
                    </StatePanel>
                  ) : (
                    <div className="space-y-2">
                      <Label htmlFor="google-source-choice">{choiceLabel}</Label>
                      <Select
                        value={selected?.id ?? ''}
                        onValueChange={value => {
                          const item = data.items.find(item => item.nativeId === value);
                          setSelected(
                            item
                              ? { id: item.nativeId, title: item.title }
                              : value === 'bounded-mailbox' && kind === 'gmail'
                                ? { id: 'bounded-mailbox', title: 'All labels within these dates' }
                                : null,
                          );
                        }}
                      >
                        <SelectTrigger
                          id="google-source-choice"
                          width="full"
                          aria-invalid={attempted && !selected}
                          aria-describedby={attempted && !selected ? 'google-choice-error' : undefined}
                        >
                          <SelectValue placeholder="Choose a source">{selected?.title}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">Choose a source</SelectItem>
                          {kind === 'gmail' && (
                            <SelectItem value="bounded-mailbox">All labels within these dates</SelectItem>
                          )}
                          {selected &&
                            selected.id !== 'bounded-mailbox' &&
                            !data.items.some(item => item.nativeId === selected.id) && (
                              <SelectItem value={selected.id}>{selected.title}</SelectItem>
                            )}
                          {data.items.map(item => (
                            <SelectItem key={item.nativeId} value={item.nativeId}>
                              {item.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {(cursors.length > 1 || data.nextCursor) && (
                    <nav aria-label="Google choice pages" className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        disabled={cursors.length === 1}
                        onClick={() => setCursors(cursors.slice(0, -1))}
                      >
                        Previous choices
                      </Button>
                      <Button
                        variant="outline"
                        disabled={!data.nextCursor}
                        onClick={() => {
                          if (data.nextCursor) setCursors([...cursors, data.nextCursor]);
                        }}
                      >
                        Next choices
                      </Button>
                    </nav>
                  )}
                </div>
              )
            }
          </ReadResult>
          {attempted && !selected && (
            <p id="google-choice-error" role="alert" className="text-sm text-destructive">
              Choose a Google source before saving.
            </p>
          )}
          {kind === 'gmail' ? (
            <div className="space-y-3">
              <p id="google-date-help" className="text-sm text-muted-foreground">
                UTC dates, at most 366 days apart. After is inclusive; before is exclusive. Attachments are not
                searchable.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="google-after">After date</Label>
                  <Input
                    id="google-after"
                    type="date"
                    value={after}
                    onChange={event => setAfter(event.target.value)}
                    aria-invalid={attempted && dateInvalid}
                    aria-describedby="google-date-help"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="google-before">Before date</Label>
                  <Input
                    id="google-before"
                    type="date"
                    value={before}
                    onChange={event => setBefore(event.target.value)}
                    aria-invalid={attempted && dateInvalid}
                    aria-describedby="google-date-help"
                  />
                </div>
              </div>
              {attempted && dateInvalid && (
                <p role="alert" className="text-sm text-destructive">
                  Enter valid dates with before later than after, no more than 366 days apart.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Checkbox id="google-share" checked={shared} onCheckedChange={checked => setShared(checked)} />
                <Label htmlFor="google-share">Share with selected workspace members</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                You are always included. Each selected reader needs their own Google integration and Google access to
                the original files. Selection does not grant Google permission.
              </p>
              {shared && (
                <ReadResult state={members.state} retry={members.refresh} label="workspace members">
                  {() => (
                    <div className="space-y-3">
                      <SearchField label="Find source readers" value={search} onChange={setSearch} />
                      {!candidates.length ? (
                        <p>No other current workspace members are available.</p>
                      ) : !visible.length ? (
                        <StatePanel
                          kind="empty"
                          heading="h3"
                          title="No members match"
                          description="Try another name or email."
                        >
                          <Button variant="outline" onClick={() => setSearch('')}>
                            Clear member search
                          </Button>
                        </StatePanel>
                      ) : (
                        <ul className="max-h-64 space-y-3 overflow-y-auto p-3">
                          {visible.map(member => (
                            <li key={member.id} className="flex items-center gap-3">
                              <Checkbox
                                id={`google-member-${member.id}`}
                                checked={memberIds.includes(member.id)}
                                disabled={!memberIds.includes(member.id) && memberIds.length >= 100}
                                onCheckedChange={checked =>
                                  setMemberIds(ids =>
                                    checked ? [...ids, member.id] : ids.filter(id => id !== member.id),
                                  )
                                }
                              />
                              <Label htmlFor={`google-member-${member.id}`}>
                                {member.name || member.email} ({member.email})
                              </Label>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="text-sm text-muted-foreground">{memberIds.length} readers selected, plus you.</p>
                    </div>
                  )}
                </ReadResult>
              )}
              {attempted && !audienceReady && (
                <Alert variant="destructive">
                  <AlertDescription>
                    Load the current workspace members and select at least one reader, or turn off sharing to keep this
                    source private.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </fieldset>
        <CommandFeedback state={command.state} retry={command.retry} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={command.locked || !discoveryReady} aria-busy={busy}>
            {busy ? 'Saving Google source…' : 'Save Google source'}
          </Button>
          <Button variant="ghost" disabled={command.locked} onClick={onClose}>
            Cancel selection
          </Button>
        </div>
        {command.locked && (
          <p role="status" className="text-sm text-muted-foreground">
            Keep this selection open until the save is confirmed. A timed-out request may still complete.
          </p>
        )}
      </form>
    </section>
  );
}
