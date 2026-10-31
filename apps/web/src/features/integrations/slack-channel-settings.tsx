import { type KeyboardEvent, useId, useMemo, useState } from 'react';
import { ChevronRight, HashIcon, LockIcon, Plus, X } from 'lucide-react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { ChoiceGroup, Field } from '@tulipfarm/sprout/field';
import { SearchField } from '@tulipfarm/sprout/search-field';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@tulipfarm/sprout/combobox';
import { Textarea } from '@tulipfarm/sprout/textarea';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@tulipfarm/sprout/sheet';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Table, type TableColumn } from '@tulipfarm/sprout/table';
import { ToggleGroup, ToggleGroupItem } from '@tulipfarm/sprout/toggle-group';
import { SlackChannelName, slackChannelLabel, slackChannelMatches } from '@/components/slack-channel-name';
import { useFlag } from '@/lib/feature-flags';
import { useFeatureRead } from '@/lib/query';
import { UnsavedChanges } from '@/features/tables/feedback';
import { integrationKeys } from './queries';
import {
  SlackChannelConflict,
  loadSlackChannelSettings,
  loadSlackEmoji,
  maxReactionPromptLength,
  maxReactionRules,
  saveSlackChannelSetting,
  type SlackChannelChange,
  type SlackChannelSetting,
  type SlackChannelSettings,
  type SlackReactionRule,
  type SlackReplyRule,
} from './slack-channel-settings-api';
import { type CustomEmoji, SlackEmoji, SlackEmojiPicker, useEmojiGlyphs } from './slack-emoji';

type Filter = 'all' | 'every-message' | 'reactions';
type Row = {
  id: string;
  channel: string;
  agent: string;
  replies: string;
  reactions: string;
  setting: SlackChannelSetting;
};

const defaultAgentValue = 'default';
const defaultAgentName = 'TulipFarm';
const starterReactions = ['bookmark', 'ticket', 'eyes', 'memo', 'white_check_mark'];
const noCustomEmoji: CustomEmoji = new Map();

type Emoji = { glyphs: ReturnType<typeof useEmojiGlyphs>; custom: CustomEmoji };

const replyOptions = [
  {
    value: 'tag',
    label: 'Mentions',
    description: 'Replies when someone tags the agent, then follows that thread.',
  },
  {
    value: 'every-message',
    label: 'Every message',
    description: 'Replies in a thread to each new top-level message, without a tag.',
  },
] as const satisfies readonly { value: SlackReplyRule; label: string; description: string }[];

export function SlackChannelSettingsTab({ workspaceId }: { workspaceId: string }) {
  const read = useFeatureRead({
    key: [...integrationKeys.content('slack'), 'channel-settings'],
    load: signal => loadSlackChannelSettings(workspaceId, signal),
  });
  const [saved, setSaved] = useState<Record<string, SlackChannelSetting>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const reactionsEnabled = useFlag('slack-reactions');
  const emojiRead = useFeatureRead({
    key: [...integrationKeys.content('slack'), 'emoji'],
    load: signal => loadSlackEmoji(workspaceId, signal),
    enabled: reactionsEnabled,
  });
  const glyphs = useEmojiGlyphs();
  const custom = useMemo(
    () =>
      emojiRead.state.kind === 'ready'
        ? new Map(emojiRead.state.data.custom.map(emoji => [emoji.name, emoji.url]))
        : noCustomEmoji,
    [emojiRead.state],
  );
  const emoji: Emoji = { glyphs, custom };
  const state = read.state;

  if (state.kind === 'loading')
    return (
      <StatePanel
        kind="loading"
        heading="h2"
        title="Loading channels"
        description="Checking which channels TulipFarm is in and how it replies."
      />
    );
  if (state.kind === 'unavailable')
    return (
      <StatePanel
        kind="unavailable"
        heading="h2"
        title="Channels unavailable"
        description="A Slack integration manager can grant you access to this integration."
      />
    );
  if (state.kind === 'error')
    return (
      <StatePanel
        kind="error"
        heading="h2"
        title="Channels didn't load"
        description="Check your connection, then try again."
      >
        <Button variant="outline" onClick={() => void read.refresh()}>
          Try again
        </Button>
      </StatePanel>
    );

  const data = state.data;
  const channels = data.channels.map(channel => {
    const local = saved[channel.id];
    return local && local.version >= channel.version ? local : channel;
  });
  const agentName = (id: string | null) =>
    id === null ? defaultAgentName : (data.agents.find(agent => agent.id === id)?.name ?? 'Another agent');
  const counts = {
    all: channels.length,
    'every-message': channels.filter(channel => channel.replies === 'every-message').length,
    reactions: channels.filter(channel => channel.reactions.length > 0).length,
  };
  const rows: Row[] = channels
    .filter(channel =>
      filter === 'every-message'
        ? channel.replies === 'every-message'
        : filter === 'reactions'
          ? channel.reactions.length > 0
          : true,
    )
    .filter(channel => slackChannelMatches(channel.name, query))
    .map(channel => ({
      id: channel.id,
      channel: slackChannelLabel(channel.name),
      agent: agentName(channel.agentId),
      replies: channel.replies,
      reactions: channel.reactions.map(rule => `${rule.reaction} ${rule.prompt}`).join(' '),
      setting: channel,
    }));

  const allColumns: TableColumn<Row>[] = [
    {
      key: 'channel',
      header: 'Channel',
      cell: row => (
        // Sprout's row button doesn't constrain its width, so cap it here to truncate long names.
        <span className="flex max-w-64 min-w-0 items-center gap-2 sm:max-w-88">
          <span className="inline-flex shrink-0 text-muted-foreground">
            {row.setting.private ? (
              <LockIcon aria-hidden="true" className="size-4" />
            ) : (
              <HashIcon aria-hidden="true" className="size-4" />
            )}
          </span>
          <span className="min-w-0 truncate" title={row.channel}>
            {row.channel}
          </span>
          {row.setting.private && <span className="sr-only">(private channel)</span>}
          {!row.setting.botMember && (
            <span className="shrink-0">
              <Badge variant="warning">Not in channel</Badge>
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'agent',
      header: 'Agent',
      cell: row =>
        row.setting.agentId === null ? <span className="text-muted-foreground">{row.agent} (default)</span> : row.agent,
    },
    {
      key: 'replies',
      header: 'Replies to',
      cell: row =>
        row.setting.replies === 'every-message' ? (
          <Badge variant="info">Every message</Badge>
        ) : (
          <span className="text-muted-foreground">Mentions</span>
        ),
    },
    {
      key: 'reactions',
      header: 'Reactions',
      cell: row =>
        row.setting.reactions.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <ul className="flex min-w-0 flex-col gap-1">
            {row.setting.reactions.map(rule => (
              <li key={rule.reaction} className="flex min-w-0 items-start gap-2">
                <span aria-hidden="true" title={`:${rule.reaction}:`} className="flex">
                  <SlackEmoji name={rule.reaction} glyphs={emoji.glyphs} custom={emoji.custom} />
                </span>
                <span className="block max-w-48 truncate min-[90rem]:max-w-80" title={rule.prompt}>
                  <span className="sr-only">:{rule.reaction}: </span>
                  {rule.prompt}
                </span>
              </li>
            ))}
          </ul>
        ),
    },
  ];
  const columns = allColumns.filter(column => reactionsEnabled || column.key !== 'reactions');

  const current = channels.find(channel => channel.id === editing) ?? null;
  const edit = (row: Row) => {
    setNotice(null);
    setEditing(row.id);
  };
  const noMatches = (
    <StatePanel
      kind="empty"
      heading="h3"
      title="No matching channels"
      description="Try another name or show all channels."
    >
      <Button
        variant="outline"
        onClick={() => {
          setQuery('');
          setFilter('all');
        }}
      >
        Show all channels
      </Button>
    </StatePanel>
  );

  return (
    <section className="space-y-4" aria-label="Slack channels">
      {data.missingScopes.length > 0 && (
        <Alert>
          <AlertDescription>
            Some channels may be missing. Reconnect Slack so TulipFarm can list them (it needs{' '}
            {data.missingScopes.join(', ')}).
          </AlertDescription>
        </Alert>
      )}
      {channels.length === 0 ? (
        <StatePanel
          kind="empty"
          heading="h3"
          title="TulipFarm isn't in any channels yet"
          description="In Slack, type /invite @TulipFarm in a channel. It appears here once TulipFarm joins."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-full sm:w-64">
              <SearchField label="Filter channels" value={query} onChange={setQuery} />
            </div>
            <ToggleGroup
              aria-label="Show channels"
              variant="outline"
              spacing={0}
              value={[filter]}
              onValueChange={value => {
                const next = value[0] as Filter | undefined;
                if (next) setFilter(next);
              }}
            >
              <ToggleGroupItem value="all">
                All <Count value={counts.all} />
              </ToggleGroupItem>
              <ToggleGroupItem value="every-message">
                Every message <Count value={counts['every-message']} />
              </ToggleGroupItem>
              {reactionsEnabled && (
                <ToggleGroupItem value="reactions">
                  Reactions <Count value={counts.reactions} />
                </ToggleGroupItem>
              )}
            </ToggleGroup>
            {/* Kept mounted so the announcement is reliable; sits in the toolbar so saving doesn't shift the table. */}
            {data.canManage && !notice && (
              <p className="text-sm text-muted-foreground sm:ml-auto">
                {reactionsEnabled
                  ? 'Select a channel to edit its agent, replies or reactions.'
                  : 'Select a channel to edit its agent or replies.'}
              </p>
            )}
            <p role="status" className={notice ? 'text-sm sm:ml-auto' : 'sr-only'}>
              {notice}
            </p>
          </div>
          {!data.canManage && (
            <p className="text-sm text-muted-foreground">Only Slack integration managers can change these settings.</p>
          )}
          {data.canManage ? (
            <Table
              aria-label="Slack channels"
              data={rows}
              columns={columns}
              getRowId={row => row.id}
              rowLabel={row => row.channel}
              narrow="stack"
              onRowClick={edit}
              actions={row => (
                // The row's channel button is the keyboard path; this is the pointer target.
                // Stacked cards are tappable as a whole, so the chevron is hidden there.
                <span className="@max-[36rem]/sprout-table:hidden">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    tabIndex={-1}
                    aria-label={`Edit ${row.channel}`}
                    onClick={() => edit(row)}
                  >
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </span>
              )}
              empty={noMatches}
            />
          ) : (
            <Table
              aria-label="Slack channels"
              data={rows}
              columns={columns}
              getRowId={row => row.id}
              rowLabel={row => row.channel}
              narrow="stack"
              empty={noMatches}
            />
          )}
        </>
      )}
      {current && (
        <ChannelEditor
          key={`${current.id}:${current.version}`}
          workspaceId={workspaceId}
          channel={current}
          data={data}
          emoji={emoji}
          reactionsEnabled={reactionsEnabled}
          onSaved={channel => {
            setSaved(previous => ({ ...previous, [channel.id]: channel }));
            setEditing(null);
            setNotice(`Saved ${slackChannelLabel(channel.name)}. New messages there use these settings.`);
          }}
          onReload={() => void read.refresh()}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function Count({ value }: { value: number }) {
  return <span className="tabular-nums text-muted-foreground">{value}</span>;
}

function ChannelEditor({
  workspaceId,
  channel,
  data,
  emoji,
  reactionsEnabled,
  onSaved,
  onReload,
  onClose,
}: {
  workspaceId: string;
  channel: SlackChannelSetting;
  data: SlackChannelSettings;
  emoji: Emoji;
  reactionsEnabled: boolean;
  onSaved: (channel: SlackChannelSetting) => void;
  onReload: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SlackChannelChange>({
    agentId: channel.agentId,
    replies: channel.replies,
    reactions: channel.reactions,
  });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<'conflict' | 'error' | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const agentInputId = useId();
  const reactionInputId = useId();
  // Sprout's combobox input keeps Escape even with its list closed, so pass it on to close the sheet.
  const escapeClosedList = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && event.currentTarget.getAttribute('aria-expanded') !== 'true') requestClose();
  };
  const [showErrors, setShowErrors] = useState(false);
  const promptError = (prompt: string) =>
    prompt.trim().length === 0
      ? 'Tell the agent what to do.'
      : prompt.length > maxReactionPromptLength
        ? `Use ${maxReactionPromptLength.toLocaleString()} characters or fewer.`
        : undefined;
  const dirty =
    draft.agentId !== channel.agentId ||
    draft.replies !== channel.replies ||
    JSON.stringify(draft.reactions) !== JSON.stringify(channel.reactions);
  const requestClose = () => {
    if (saving) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  };
  const used = draft.reactions.map(rule => rule.reaction);
  const nextReaction = starterReactions.find(name => !used.includes(name));
  const agentLabel = (id: string | null) =>
    id === null
      ? `${defaultAgentName} (default)`
      : (data.agents.find(agent => agent.id === id)?.name ?? 'Another agent');

  async function save() {
    const firstInvalid = draft.reactions.findIndex(rule => promptError(rule.prompt) !== undefined);
    if (firstInvalid !== -1) {
      setShowErrors(true);
      document.querySelector<HTMLTextAreaElement>(`[data-reaction-prompt="${firstInvalid}"]`)?.focus();
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      onSaved({ ...channel, ...(await saveSlackChannelSetting(workspaceId, channel.id, channel.version, draft)) });
    } catch (error) {
      setFailure(error instanceof SlackChannelConflict ? 'conflict' : 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onOpenChange={open => {
        if (!open) requestClose();
      }}
    >
      <SheetContent size="lg" closeLabel="Close channel settings">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={event => {
            event.preventDefault();
            void save();
          }}
        >
          <SheetHeader>
            <SheetTitle>
              <SlackChannelName title={channel.name} private={channel.private} />
            </SheetTitle>
            <SheetDescription>
              {channel.private ? 'Private' : 'Public'}
              {channel.members !== null && (
                <>
                  {' · '}
                  <span className="tabular-nums">{channel.members.toLocaleString()}</span>{' '}
                  {channel.members === 1 ? 'member' : 'members'}
                </>
              )}
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <div className="space-y-6">
              {!channel.botMember && (
                <Alert>
                  <AlertDescription>
                    TulipFarm isn't in this channel, so these settings wait until someone types /invite @TulipFarm
                    there.
                  </AlertDescription>
                </Alert>
              )}
              <Field
                required
                id={agentInputId}
                label="Agent"
                helper="Threads already in progress keep the agent that started them."
              >
                <Combobox<string>
                  items={[defaultAgentValue, ...data.agents.map(agent => agent.id)]}
                  value={draft.agentId ?? defaultAgentValue}
                  itemToStringLabel={value => agentLabel(value === defaultAgentValue ? null : value)}
                  onValueChange={value => {
                    if (value)
                      setDraft(previous => ({ ...previous, agentId: value === defaultAgentValue ? null : value }));
                  }}
                >
                  <ComboboxInput id={agentInputId} placeholder="Search agents" onKeyDown={escapeClosedList} />
                  <ComboboxContent>
                    <ComboboxEmpty>No agents match.</ComboboxEmpty>
                    <ComboboxList>
                      {(value: string) => (
                        <ComboboxItem key={value} value={value}>
                          {agentLabel(value === defaultAgentValue ? null : value)}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </Field>
              <ChoiceGroup
                required
                legend="Replies to"
                type="radio"
                options={replyOptions}
                value={draft.replies}
                onValueChange={replies => setDraft(previous => ({ ...previous, replies }))}
              />
              {reactionsEnabled && (
                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium">Reactions</legend>
                  <p className="text-sm text-muted-foreground">
                    When anyone reacts to a message with one of these emoji, the agent follows your prompt on that
                    message and its thread. It can use any tool it has, like adding a table row or replying in the
                    thread.
                  </p>
                  {draft.reactions.length > 0 && (
                    <ul className="space-y-3">
                      {draft.reactions.map((rule, index) => {
                        const error = showErrors ? promptError(rule.prompt) : undefined;
                        const update = (change: Partial<SlackReactionRule>) =>
                          setDraft(previous => ({
                            ...previous,
                            reactions: previous.reactions.map((item, at) =>
                              at === index ? { ...item, ...change } : item,
                            ),
                          }));
                        return (
                          <li key={index} className="space-y-3 rounded-lg border p-3">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0 flex-1 sm:max-w-72">
                                <Field
                                  id={`${reactionInputId}-${index}`}
                                  label={`Reaction ${index + 1}`}
                                  labelVisibility="screen-reader"
                                  required
                                >
                                  <SlackEmojiPicker
                                    id={`${reactionInputId}-${index}`}
                                    value={rule.reaction}
                                    taken={used.filter(name => name !== rule.reaction)}
                                    glyphs={emoji.glyphs}
                                    custom={emoji.custom}
                                    onValueChange={reaction => update({ reaction })}
                                    onKeyDown={escapeClosedList}
                                  />
                                </Field>
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={`Remove :${rule.reaction}: reaction`}
                                onClick={() =>
                                  setDraft(previous => ({
                                    ...previous,
                                    reactions: previous.reactions.filter((_, at) => at !== index),
                                  }))
                                }
                              >
                                <X aria-hidden="true" />
                              </Button>
                            </div>
                            <Field
                              required
                              label="Prompt"
                              counter={`${rule.prompt.length.toLocaleString()} / ${maxReactionPromptLength.toLocaleString()}`}
                              error={error}
                            >
                              <Textarea
                                data-reaction-prompt={index}
                                rows={3}
                                value={rule.prompt}
                                placeholder="For example: Add this message to Support tickets with a one-line summary, then reply in the thread with a link to the row."
                                onChange={event => update({ prompt: event.target.value })}
                              />
                            </Field>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {draft.reactions.length < maxReactionRules && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const reaction = nextReaction ?? starterReactions[0] ?? 'bookmark';
                        setDraft(previous => ({
                          ...previous,
                          reactions: [...previous.reactions, { reaction, prompt: '' }],
                        }));
                      }}
                    >
                      <Plus aria-hidden="true" />
                      Add reaction
                    </Button>
                  )}
                </fieldset>
              )}
              {failure && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {failure === 'conflict' ? (
                      <div className="space-y-2">
                        <p>
                          Someone else changed this channel. Your edits are still here, but saving needs their latest
                          version.
                        </p>
                        <Button type="button" variant="outline" size="sm" onClick={onReload}>
                          Load their changes
                        </Button>
                      </div>
                    ) : (
                      'Settings didn’t save. Check your connection, then try again.'
                    )}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </SheetBody>
          <SheetFooter>
            <Button type="submit" disabled={saving} aria-busy={saving}>
              {saving ? 'Saving…' : 'Save channel'}
            </Button>
            <Button type="button" variant="outline" disabled={saving} onClick={requestClose}>
              Cancel
            </Button>
          </SheetFooter>
        </form>
        <UnsavedChanges dirty={dirty || saving} />
        <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
          <AlertDialogContent>
            <AlertDialogTitle>Leave these edits?</AlertDialogTitle>
            <AlertDialogDescription>Your unsaved changes to this channel will be lost.</AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={onClose}>
                Leave editor
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
