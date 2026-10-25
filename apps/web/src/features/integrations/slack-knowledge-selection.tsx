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
  SlackKnowledgeError,
  slackConcealKeys,
  slackCorpusKindSchema,
  slackCorpusSelectionSchema,
  slackErrorMessages,
  slackSourceKeys,
  type ConfigureSlack,
  type SlackConversationChoice,
  type SlackKind,
  type SlackKnowledgeApi,
  type SlackSource,
} from './slack-knowledge-api';
import { CommandFeedback, ReadResult, useCommand } from './slack-knowledge-shared';
import { PrivateMark } from '@/components/private-mark';

const day = 86_400_000;
const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);

export function SlackSelectionForm({
  api,
  onSaved,
  onClose,
}: {
  api: SlackKnowledgeApi;
  onSaved: (source: SlackSource) => Promise<void>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<SlackKind>('channels');
  const [selected, setSelected] = useState<SlackConversationChoice[]>([]);
  const [after, setAfter] = useState(() => isoDate(Date.now() - 90 * day));
  const [shared, setShared] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const scope = useFeatureScope();
  const discovery = useFeatureRead({
    key: [...slackSourceKeys, 'discover', kind, cursor],
    staleTime: 0,
    load: signal =>
      api.discover(kind, cursor, signal).then(
        data => ({ ...data, blocked: null }),
        (error: unknown) => {
          const message = error instanceof SlackKnowledgeError ? slackErrorMessages[error.code] : undefined;
          if (message) return { binding: null, items: [], nextCursor: null, blocked: message };
          throw error;
        },
      ),
  });
  const members = useFeatureRead({
    key: [...slackSourceKeys, 'members'],
    load: api.members,
    enabled: shared && kind === 'channels',
  });
  const command = useCommand<ConfigureSlack, SlackSource>(
    (input, signal) => api.configure(input, signal),
    onSaved,
    slackConcealKeys,
  );
  const selection = slackCorpusSelectionSchema.safeParse({
    kind,
    conversationIds: selected.map(item => item.conversationId).sort(),
    after,
  });
  const start = Date.parse(after);
  const dateInvalid = !Number.isFinite(start) || start > Date.now() || Date.now() - start > 366 * day;
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
  const toggle = (item: SlackConversationChoice, checked: boolean) =>
    setSelected(current =>
      checked
        ? [...current.filter(value => value.conversationId !== item.conversationId), item]
        : current.filter(value => value.conversationId !== item.conversationId),
    );
  const automatic = useFlag('default-connection-knowledge');
  return (
    <section aria-label="Select Slack conversations" className="space-y-4 border-t pt-4">
      <h4 className="text-base font-medium">Select Slack conversations</h4>
      <p className="text-sm text-muted-foreground">
        Choose up to 50 conversations you belong to.{' '}
        {automatic
          ? 'Automatic Knowledge covers channels you’ve joined; add direct or group messages here.'
          : 'Linking Slack does not import your whole workspace.'}{' '}
        Only messages after the chosen date are imported, one thread per document.
      </p>
      <form
        noValidate
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          setAttempted(true);
          if (command.locked || !selection.success || dateInvalid || !audienceReady || !discoveryReady) return;
          void command.send({
            commandId: crypto.randomUUID(),
            selection: selection.data,
            memberIds: kind === 'personal' || !shared ? [] : memberIds,
          });
        }}
      >
        <fieldset disabled={command.locked} className="min-w-0 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="slack-source-kind">Conversation type</Label>
            <Select
              value={kind}
              onValueChange={value => {
                const result = slackCorpusKindSchema.safeParse(value);
                if (result.success) {
                  setKind(result.data);
                  setSelected([]);
                  setCursors([null]);
                  setAttempted(false);
                  if (result.data === 'personal') {
                    setShared(false);
                    setMemberIds([]);
                  }
                }
              }}
            >
              <SelectTrigger id="slack-source-kind" width="full">
                <SelectValue>
                  {kind === 'channels' ? 'Public and private channels' : 'Direct and group messages'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="channels">Public and private channels</SelectItem>
                <SelectItem value="personal">Direct and group messages</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <ReadResult state={discovery.state} retry={discovery.refresh} label="Slack conversations">
            {data =>
              data.blocked ? (
                <StatePanel
                  kind="unavailable"
                  heading="h3"
                  title="Slack conversations unavailable"
                  description={data.blocked}
                >
                  <Button variant="outline" onClick={() => void discovery.refresh()}>
                    Check Slack again
                  </Button>
                </StatePanel>
              ) : (
                <div className="space-y-3">
                  {data.items.length === 0 ? (
                    <StatePanel
                      kind="empty"
                      heading="h3"
                      title="No Slack conversations on this page"
                      description={
                        kind === 'personal'
                          ? 'No direct or group messages were returned for your Slack link.'
                          : 'Join a channel in Slack, or check that your Slack link allows reading channels.'
                      }
                    >
                      <Button variant="outline" onClick={() => void discovery.refresh()}>
                        Check Slack conversations again
                      </Button>
                    </StatePanel>
                  ) : (
                    <fieldset
                      className="space-y-2"
                      aria-describedby={attempted && !selected.length ? 'slack-choice-error' : undefined}
                    >
                      <legend className="text-sm font-medium">Conversations</legend>
                      <ul className="max-h-64 space-y-3 overflow-y-auto p-3">
                        {data.items.map(item => (
                          <li key={item.conversationId} className="flex items-center gap-3">
                            <Checkbox
                              id={`slack-conversation-${item.conversationId}`}
                              checked={selected.some(value => value.conversationId === item.conversationId)}
                              disabled={
                                !selected.some(value => value.conversationId === item.conversationId) &&
                                selected.length >= 50
                              }
                              onCheckedChange={checked => toggle(item, checked)}
                            />
                            <Label htmlFor={`slack-conversation-${item.conversationId}`}>
                              {item.title}
                              {item.kind === 'private' && <PrivateMark label="Private channel" />}
                            </Label>
                          </li>
                        ))}
                      </ul>
                    </fieldset>
                  )}
                  {(cursors.length > 1 || data.nextCursor) && (
                    <nav aria-label="Slack conversation pages" className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        disabled={cursors.length === 1}
                        onClick={() => setCursors(cursors.slice(0, -1))}
                      >
                        Previous conversations
                      </Button>
                      <Button
                        variant="outline"
                        disabled={!data.nextCursor}
                        onClick={() => {
                          if (data.nextCursor) setCursors([...cursors, data.nextCursor]);
                        }}
                      >
                        Next conversations
                      </Button>
                    </nav>
                  )}
                  <p role="status" className="text-sm text-muted-foreground">
                    {selected.length} {selected.length === 1 ? 'conversation' : 'conversations'} selected.
                  </p>
                </div>
              )
            }
          </ReadResult>
          {attempted && !selected.length && (
            <p id="slack-choice-error" role="alert" className="text-sm text-destructive">
              Choose at least one Slack conversation before saving.
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="slack-after">Import messages after</Label>
            <Input
              id="slack-after"
              type="date"
              value={after}
              onChange={event => setAfter(event.target.value)}
              aria-invalid={attempted && dateInvalid}
              aria-describedby={`slack-date-help${attempted && dateInvalid ? ' slack-date-error' : ''}`}
            />
            <p id="slack-date-help" className="text-sm text-muted-foreground">
              UTC date within the last 366 days. Edits and deletions in Slack are reconciled on later syncs.
            </p>
            {attempted && dateInvalid && (
              <p id="slack-date-error" role="alert" className="text-sm text-destructive">
                Enter a date that is not in the future and no more than 366 days ago.
              </p>
            )}
          </div>
          {kind === 'personal' ? (
            <p className="text-sm text-muted-foreground">
              Direct and group messages stay private to you. They cannot be shared with other members.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Checkbox id="slack-share" checked={shared} onCheckedChange={checked => setShared(checked)} />
                <Label htmlFor="slack-share">Share with selected workspace members</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                You are always included. Each selected reader sees a conversation only after their own linked Slack
                account confirms they are still a member. Workspace admins get no automatic access.
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
                                id={`slack-member-${member.id}`}
                                checked={memberIds.includes(member.id)}
                                disabled={!memberIds.includes(member.id) && memberIds.length >= 100}
                                onCheckedChange={checked =>
                                  setMemberIds(ids =>
                                    checked ? [...ids, member.id] : ids.filter(id => id !== member.id),
                                  )
                                }
                              />
                              <Label htmlFor={`slack-member-${member.id}`}>
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
            {busy ? 'Saving Slack source…' : 'Save Slack source'}
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
