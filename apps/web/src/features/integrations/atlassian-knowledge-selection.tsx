import { useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useFeatureRead, useFeatureScope } from '@/lib/query';
import {
  AtlassianKnowledgeError,
  atlassianConcealKeys,
  atlassianCorpusSelectionSchema,
  atlassianErrorMessages,
  atlassianSourceKeys,
  atlassianTargetKey,
  type AtlassianKnowledgeApi,
  type AtlassianProduct,
  type AtlassianSource,
  type AtlassianTargetChoice,
  type ConfigureAtlassian,
  type DiscoverKind,
} from './atlassian-knowledge-api';
import { CommandFeedback, ReadResult, useCommand } from './slack-knowledge-shared';

const productNames = { confluence: 'Confluence', jira: 'Jira' } as const;
const blocked = (error: unknown) =>
  error instanceof AtlassianKnowledgeError ? atlassianErrorMessages[error.code] : undefined;

function TargetList({
  api,
  cloudId,
  kind,
  within,
  selected,
  toggle,
  label,
}: {
  api: AtlassianKnowledgeApi;
  cloudId: string;
  kind: DiscoverKind;
  within: string | null;
  label: string;
  selected: AtlassianTargetChoice[];
  toggle: (item: AtlassianTargetChoice, checked: boolean) => void;
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const discovery = useFeatureRead({
    key: [...atlassianSourceKeys, 'discover', cloudId, kind, within, cursor],
    staleTime: 0,
    load: signal =>
      api.discover(cloudId, kind, within, cursor, signal).then(
        data => ({ ...data, blocked: null }),
        (error: unknown) => {
          const message = blocked(error);
          if (message) return { binding: null, items: [], nextCursor: null, blocked: message };
          throw error;
        },
      ),
  });
  return (
    <ReadResult state={discovery.state} retry={discovery.refresh} label={label}>
      {data =>
        data.blocked ? (
          <StatePanel kind="unavailable" heading="h3" title={`${label} unavailable`} description={data.blocked}>
            <Button variant="outline" onClick={() => void discovery.refresh()}>
              Check Atlassian again
            </Button>
          </StatePanel>
        ) : (
          <div className="space-y-3">
            {data.items.length === 0 ? (
              <StatePanel
                kind="empty"
                heading="h3"
                title={`No ${label.toLowerCase()} on this page`}
                description="Your Atlassian account returned nothing here. Check that you can view it in Atlassian."
              >
                <Button variant="outline" onClick={() => void discovery.refresh()}>
                  Check {label.toLowerCase()} again
                </Button>
              </StatePanel>
            ) : (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{label}</legend>
                <ul className="max-h-64 space-y-3 overflow-y-auto p-3">
                  {data.items.map(item => {
                    const key = atlassianTargetKey(item);
                    const checked = selected.some(value => atlassianTargetKey(value) === key);
                    return (
                      <li key={key} className="flex items-center gap-3">
                        <Checkbox
                          id={`atlassian-target-${key}`}
                          checked={checked}
                          disabled={!checked && selected.length >= 50}
                          onCheckedChange={value => toggle(item, value)}
                        />
                        <Label htmlFor={`atlassian-target-${key}`}>
                          {item.title}
                          {item.key ? ` (${item.key})` : ''}
                        </Label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            )}
            {(cursors.length > 1 || data.nextCursor) && (
              <nav aria-label={`${label} pages`} className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={cursors.length === 1}
                  onClick={() => setCursors(cursors.slice(0, -1))}
                >
                  Previous {label.toLowerCase()}
                </Button>
                <Button
                  variant="outline"
                  disabled={!data.nextCursor}
                  onClick={() => {
                    if (data.nextCursor) setCursors([...cursors, data.nextCursor]);
                  }}
                >
                  Next {label.toLowerCase()}
                </Button>
              </nav>
            )}
          </div>
        )
      }
    </ReadResult>
  );
}

export function AtlassianSelectionForm({
  api,
  product,
  onSaved,
  onClose,
}: {
  api: AtlassianKnowledgeApi;
  product: AtlassianProduct;
  onSaved: (source: AtlassianSource) => Promise<void>;
  onClose: () => void;
}) {
  const [cloudId, setCloudId] = useState<string | null>(null);
  const [mode, setMode] = useState<'spaces' | 'pages'>('spaces');
  const [space, setSpace] = useState<string | null>(null);
  const [descendants, setDescendants] = useState(true);
  const [selected, setSelected] = useState<AtlassianTargetChoice[]>([]);
  const [shared, setShared] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [attempted, setAttempted] = useState(false);
  const scope = useFeatureScope();
  const sites = useFeatureRead({
    key: [...atlassianSourceKeys, 'sites'],
    staleTime: 0,
    load: signal =>
      api.sites(signal).then(
        data => ({ ...data, blocked: null }),
        (error: unknown) => {
          const message = blocked(error);
          if (message) return { items: [], blocked: message };
          throw error;
        },
      ),
  });
  const site = cloudId ?? (sites.state.kind === 'ready' ? (sites.state.data.items[0]?.cloudId ?? null) : null);
  const spaces = useFeatureRead({
    key: [...atlassianSourceKeys, 'discover', site, 'spaces', null, null],
    staleTime: 0,
    enabled: product === 'confluence' && mode === 'pages' && !!site,
    load: signal => (site ? api.discover(site, 'spaces', null, null, signal) : Promise.reject(new Error('site'))),
  });
  const members = useFeatureRead({ key: [...atlassianSourceKeys, 'members'], load: api.members, enabled: shared });
  const command = useCommand<ConfigureAtlassian, AtlassianSource>(
    (input, signal) => api.configure(input, signal),
    onSaved,
    atlassianConcealKeys,
  );
  const targets = selected
    .map(item => ({ kind: item.kind, id: item.id, descendants: item.kind === 'page' && descendants }))
    .sort((a, b) => (atlassianTargetKey(a) < atlassianTargetKey(b) ? -1 : 1));
  const selection = site ? atlassianCorpusSelectionSchema.safeParse({ product, cloudId: site, targets }) : null;
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
  const busy = command.state.kind === 'sending';
  const toggle = (item: AtlassianTargetChoice, checked: boolean) =>
    setSelected(current =>
      checked
        ? [...current.filter(value => atlassianTargetKey(value) !== atlassianTargetKey(item)), item]
        : current.filter(value => atlassianTargetKey(value) !== atlassianTargetKey(item)),
    );
  const name = productNames[product];
  return (
    <section aria-label={`Select ${name} content`} className="space-y-4 border-t pt-4">
      <h4 className="text-base font-medium">Select {name} content</h4>
      <p className="text-sm text-muted-foreground">
        {product === 'jira'
          ? 'Choose up to 50 projects. Each issue becomes one document with its description and unrestricted comments.'
          : 'Choose up to 50 spaces or pages. Each page becomes one document; page selections can include their child pages.'}{' '}
        Import uses your own Atlassian account.
      </p>
      <form
        noValidate
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          setAttempted(true);
          if (command.locked || !selection?.success || !audienceReady) return;
          void command.send({
            commandId: crypto.randomUUID(),
            selection: selection.data,
            memberIds: shared ? memberIds : [],
          });
        }}
      >
        <fieldset disabled={command.locked} className="min-w-0 space-y-4">
          <ReadResult state={sites.state} retry={sites.refresh} label="Atlassian sites">
            {data =>
              data.blocked || !data.items.length ? (
                <StatePanel
                  kind="unavailable"
                  heading="h3"
                  title="No Atlassian site available"
                  description={
                    data.blocked ??
                    'Connect your own Atlassian account with the REST sign-in under Advanced setup. Business accounts cannot prove your personal access.'
                  }
                >
                  <Button variant="outline" onClick={() => void sites.refresh()}>
                    Check Atlassian sites again
                  </Button>
                </StatePanel>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="atlassian-site">Atlassian site</Label>
                    <Select
                      value={site ?? ''}
                      onValueChange={value => {
                        setCloudId(value);
                        setSelected([]);
                        setSpace(null);
                      }}
                    >
                      <SelectTrigger id="atlassian-site" width="full">
                        <SelectValue>
                          {data.items.find(item => item.cloudId === site)?.name} (
                          {data.items.find(item => item.cloudId === site)?.url})
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {data.items.map(item => (
                          <SelectItem key={item.cloudId} value={item.cloudId}>
                            {item.name} ({item.url})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {product === 'confluence' && (
                    <div className="space-y-2">
                      <Label htmlFor="atlassian-mode">Import</Label>
                      <Select
                        value={mode}
                        onValueChange={value => {
                          setMode(value === 'pages' ? 'pages' : 'spaces');
                          setSelected([]);
                        }}
                      >
                        <SelectTrigger id="atlassian-mode" width="full">
                          <SelectValue>{mode === 'pages' ? 'Specific pages' : 'Whole spaces'}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="spaces">Whole spaces</SelectItem>
                          <SelectItem value="pages">Specific pages</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {site && product === 'jira' && (
                    <TargetList
                      api={api}
                      cloudId={site}
                      kind="projects"
                      within={null}
                      label="Projects"
                      selected={selected}
                      toggle={toggle}
                    />
                  )}
                  {site && product === 'confluence' && mode === 'spaces' && (
                    <TargetList
                      api={api}
                      cloudId={site}
                      kind="spaces"
                      within={null}
                      label="Spaces"
                      selected={selected}
                      toggle={toggle}
                    />
                  )}
                  {site && product === 'confluence' && mode === 'pages' && (
                    <ReadResult state={spaces.state} retry={spaces.refresh} label="Confluence spaces">
                      {list => (
                        <div className="space-y-4">
                          <div className="space-y-2">
                            <Label htmlFor="atlassian-page-space">Browse pages in space</Label>
                            <Select value={space ?? ''} onValueChange={value => setSpace(value || null)}>
                              <SelectTrigger id="atlassian-page-space" width="full">
                                <SelectValue placeholder="Choose a space">
                                  {list.items.find(item => item.id === space)?.title}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="">Choose a space</SelectItem>
                                {list.items.map(item => (
                                  <SelectItem key={item.id} value={item.id}>
                                    {item.title}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {space && (
                            <TargetList
                              api={api}
                              cloudId={site}
                              kind="pages"
                              within={space}
                              label="Pages"
                              selected={selected}
                              toggle={toggle}
                            />
                          )}
                          <div className="flex items-center gap-3">
                            <Checkbox
                              id="atlassian-descendants"
                              checked={descendants}
                              onCheckedChange={setDescendants}
                            />
                            <Label htmlFor="atlassian-descendants">Include child pages</Label>
                          </div>
                        </div>
                      )}
                    </ReadResult>
                  )}
                  <p role="status" className="text-sm text-muted-foreground">
                    {selected.length} {selected.length === 1 ? 'item' : 'items'} selected.
                  </p>
                </div>
              )
            }
          </ReadResult>
          {attempted && !selected.length && (
            <p role="alert" className="text-sm text-destructive">
              Choose at least one {product === 'jira' ? 'project' : 'space or page'} before saving.
            </p>
          )}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Checkbox id="atlassian-share" checked={shared} onCheckedChange={setShared} />
              <Label htmlFor="atlassian-share">Share with selected workspace members</Label>
            </div>
            <p className="text-sm text-muted-foreground">
              You are always included. Each selected reader sees a {product === 'jira' ? 'issue' : 'page'} only after
              their own Atlassian account confirms they can view it, including page restrictions and issue security.
              Workspace admins get no automatic access.
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
                              id={`atlassian-member-${member.id}`}
                              checked={memberIds.includes(member.id)}
                              disabled={!memberIds.includes(member.id) && memberIds.length >= 100}
                              onCheckedChange={checked =>
                                setMemberIds(ids =>
                                  checked ? [...ids, member.id] : ids.filter(id => id !== member.id),
                                )
                              }
                            />
                            <Label htmlFor={`atlassian-member-${member.id}`}>
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
        </fieldset>
        <CommandFeedback state={command.state} retry={command.retry} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={command.locked || !site} aria-busy={busy}>
            {busy ? `Saving ${name} source…` : `Save ${name} source`}
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
