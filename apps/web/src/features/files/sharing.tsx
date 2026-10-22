import { useState, type ReactNode } from 'react';
import {
  fileRoleSchema,
  type FileDirectory,
  type FileRole,
  type FileSharingContribution,
  type FileSharingSnapshot,
  type FileSubject,
} from '@tulipfarm/files/contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Label } from '@tulipfarm/sprout/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@tulipfarm/sprout/select';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { failedWrite } from '@/features/tables/request-state';
import { useFeatureRead } from '@/lib/query';
import { fileKeys, fileUrl, roleLabels, useFilesChanges, type FilesApi, type FileSummary } from './api';

type Item = Pick<FileSummary, 'id' | 'name' | 'kind'>;
type Feedback = { kind: 'done' | 'failed'; text: string } | null;
export type FinalFocus = () => HTMLElement | boolean | null;

/** Names for membership and team ids. Unknown ids belong to people or teams that left the workspace. */
export function directoryNames(directory: FileDirectory | undefined, self: string) {
  const people = new Map(directory?.members.map(member => [member.membershipId, member]));
  const teams = new Map(directory?.teams.map(team => [team.id, team.name]));
  const person = (id: string) => {
    const name = people.get(id)?.name ?? (directory ? 'Former member' : undefined);
    return id === self ? `${name ?? 'You'} (you)` : name;
  };
  return {
    person,
    subject: (subject: FileSubject) =>
      subject.kind === 'team'
        ? `${teams.get(subject.id) ?? 'Removed team'} (team)`
        : (person(subject.id) ?? 'Workspace member'),
    email: (id: string) => people.get(id)?.email ?? '',
  };
}
type Names = ReturnType<typeof directoryNames>;
const key = (subject: FileSubject) => `${subject.kind}:${subject.id}`;
const abilities: Record<FileRole, string> = { viewer: 'view', editor: 'edit', manager: 'manage' };

export function useDirectory(api: FilesApi, id: string | undefined) {
  return useFeatureRead({
    key: fileKeys.directory(id ?? 'none'),
    enabled: id !== undefined,
    staleTime: 60_000,
    load: signal => api.directory(id ?? '', signal),
  });
}

export async function copyLink(workspaceSlug: string, item: Pick<FileSummary, 'id' | 'kind'>): Promise<Feedback> {
  const url = fileUrl(workspaceSlug, item);
  try {
    await navigator.clipboard.writeText(url);
    return { kind: 'done', text: 'Link copied. Copying a link doesn’t give anyone access.' };
  } catch {
    return { kind: 'failed', text: `Couldn’t copy the link. Copy it here instead: ${url}` };
  }
}

/** People a caller needs to reach, such as members of a chat who can't open the file yet. */
export type SharingInvite = { reason: string; people: { membershipId: string; name: string }[] };

export function SharingDialog({
  api,
  item,
  membershipId,
  workspaceSlug,
  finalFocus,
  onClose,
  invite,
}: {
  api: FilesApi;
  item: Item;
  membershipId: string;
  workspaceSlug: string;
  finalFocus?: FinalFocus;
  onClose: () => void;
  invite?: SharingInvite;
}) {
  const sharing = useFeatureRead({
    key: fileKeys.sharing(item.id),
    staleTime: 0,
    load: signal => api.sharing(item.id, signal),
  });
  const directory = useDirectory(api, item.id);
  const { changed } = useFilesChanges();
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const names = directoryNames(directory.state.kind === 'ready' ? directory.state.data : undefined, membershipId);

  async function save(subjects: FileSubject | FileSubject[], role: FileRole | null, done: string) {
    const list = Array.isArray(subjects) ? subjects : [subjects];
    setPending(list.map(key).join(','));
    setFeedback(null);
    try {
      for (const subject of list) await api.share(item.id, subject, role);
      await changed();
      setFeedback({ kind: 'done', text: done });
    } catch (error) {
      const outcome = failedWrite(null, error);
      if (outcome.kind === 'rejected' && list.length === 1)
        setFeedback({ kind: 'failed', text: `${outcome.message} Access is unchanged.` });
      else {
        setFeedback({
          kind: 'failed',
          text: 'We couldn’t confirm this change. The list shows the last confirmed access.',
        });
        void sharing.refresh();
      }
    } finally {
      setPending(null);
    }
  }

  let body: ReactNode;
  if (sharing.state.kind === 'unavailable' || directory.state.kind === 'unavailable')
    body = (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title="You can’t manage access to this item"
        description="Only its owner and people who can manage it see who has access. Your access may have changed."
      />
    );
  else if (sharing.state.kind === 'error' || directory.state.kind === 'error')
    body = (
      <StatePanel
        kind="error"
        heading="h3"
        title="Couldn’t load access"
        description="Sharing is unchanged. Check your connection and try again."
      >
        <Button
          variant="outline"
          onClick={() => {
            void sharing.refresh();
            void directory.refresh();
          }}
        >
          Retry loading access
        </Button>
      </StatePanel>
    );
  else if (sharing.state.kind === 'loading' || directory.state.kind === 'loading')
    body = (
      <div role="status" aria-label="Loading access" className="space-y-3 py-2">
        <Skeleton />
        <Skeleton />
        <Skeleton />
        <span className="sr-only">Loading access…</span>
      </div>
    );
  else
    body = (
      <>
        {invite && (
          <Invitation
            invite={invite}
            snapshot={sharing.state.data}
            busy={pending !== null}
            grant={people =>
              void save(
                people.map(person => ({ kind: 'individual', id: person.membershipId })),
                'viewer',
                `${who(people)} can now view “${item.name}”.`,
              )
            }
          />
        )}
        <Access
          item={item}
          snapshot={sharing.state.data}
          directory={directory.state.data}
          names={names}
          pending={pending}
          save={(subject, role, done) => void save(subject, role, done)}
        />
      </>
    );

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && pending === null) onClose();
      }}
    >
      <DialogContent size="form" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>
            <span className="wrap-anywhere">Share “{item.name}”</span>
          </DialogTitle>
          <DialogDescription>
            People and teams you add can open this {item.kind}
            {item.kind === 'folder' ? ' and everything inside it' : ''}. Sharing never changes the owner.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 min-h-0 space-y-4 overflow-y-auto px-4 pb-1">
          {body}
          {pending !== null && (
            <p role="status" className="text-sm text-muted-foreground">
              Saving access…
            </p>
          )}
          {feedback?.kind === 'failed' && (
            <Alert variant="destructive">
              <AlertDescription>{feedback.text}</AlertDescription>
            </Alert>
          )}
          {feedback?.kind === 'done' && (
            <p role="status" className="text-sm text-foreground">
              {feedback.text}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => void copyLink(workspaceSlug, item).then(setFeedback)}>
            Copy link
          </Button>
          <Button disabled={pending !== null} onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const who = (people: SharingInvite['people']) =>
  people.length === 1
    ? (people[0]?.name ?? '1 person')
    : people.length === 2
      ? `${people[0]?.name} and ${people[1]?.name}`
      : `${people.length} people`;

function Invitation({
  invite,
  snapshot,
  busy,
  grant,
}: {
  invite: SharingInvite;
  snapshot: FileSharingSnapshot;
  busy: boolean;
  grant: (people: SharingInvite['people']) => void;
}) {
  const open = new Set(snapshot.effectiveAudience.map(member => member.membershipId));
  const remaining = invite.people.filter(person => !open.has(person.membershipId));
  if (!remaining.length)
    return (
      <p role="status" className="text-sm text-foreground">
        Everyone {invite.reason} can open it now.
      </p>
    );
  return (
    <section aria-labelledby="sharing-invite" className="space-y-2 rounded-lg border px-3 py-3">
      <h3 id="sharing-invite" className="text-sm font-medium text-foreground">
        {remaining.length === 1 ? '1 person' : `${remaining.length} people`} {invite.reason} can’t open it
      </h3>
      <p className="text-sm text-muted-foreground wrap-anywhere">{remaining.map(person => person.name).join(', ')}</p>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => grant(remaining)}>
        {remaining.length === 1 ? `Let ${remaining[0]?.name} view it` : `Let all ${remaining.length} view it`}
      </Button>
    </section>
  );
}

function Access({
  item,
  snapshot,
  directory,
  names,
  pending,
  save,
}: {
  item: Item;
  snapshot: FileSharingSnapshot;
  directory: FileDirectory;
  names: Names;
  pending: string | null;
  save: (subject: FileSubject, role: FileRole | null, done: string) => void;
}) {
  const busy = pending !== null;
  const taken = new Set(snapshot.directGrants.map(grant => key(grant.subject)));
  taken.add(key({ kind: 'individual', id: snapshot.creator.membershipId }));
  const people = directory.members.filter(member => !taken.has(key({ kind: 'individual', id: member.membershipId })));
  const teams = directory.teams.filter(team => !taken.has(key({ kind: 'team', id: team.id })));
  const [adding, setAdding] = useState('');
  const [role, setRole] = useState<FileRole>('viewer');
  const groups = snapshot.inherited.reduce<FileSharingContribution[][]>((all, entry) => {
    if (entry.kind === 'ownership') all.push([entry]);
    else all.at(-1)?.push(entry);
    return all;
  }, []);
  const audience = snapshot.effectiveAudience.map(member => names.person(member.membershipId) ?? 'Workspace member');
  const subjectFrom = (value: string): FileSubject | null => {
    const [kind, id] = value.split(':');
    return (kind === 'individual' || kind === 'team') && id ? { kind, id } : null;
  };

  return (
    <>
      <section aria-labelledby="direct-access" className="space-y-2">
        <h3 id="direct-access" className="text-sm font-medium text-foreground">
          Access to this {item.kind}
        </h3>
        <ul className="divide-y rounded-lg border">
          <li className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
            <span className="min-w-0 truncate text-sm text-foreground">
              {names.person(snapshot.creator.membershipId)}
            </span>
            <span className="text-sm text-muted-foreground">Owner</span>
          </li>
          {snapshot.directGrants.map(grant => {
            const label = names.subject(grant.subject);
            return (
              <li key={key(grant.subject)} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                <span className="min-w-0 flex-1 basis-40 truncate text-sm text-foreground" title={label}>
                  {label}
                </span>
                <div className="flex items-center gap-2">
                  <Select
                    value={grant.role}
                    disabled={busy}
                    onValueChange={value => {
                      if (!value) return;
                      const next = fileRoleSchema.parse(value);
                      save(grant.subject, next, `${label} can now ${abilities[next]}.`);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={`Access for ${label}`}>
                      <SelectValue>{roleLabels[grant.role]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {fileRoleSchema.options.map(option => (
                        <SelectItem key={option} value={option}>
                          {roleLabels[option]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Remove access for ${label}`}
                    onClick={() => save(grant.subject, null, `Removed access for ${label}.`)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {people.length + teams.length > 0 ? (
          <form
            aria-label="Add people or teams"
            className="flex flex-wrap items-end gap-2 pt-2"
            onSubmit={event => {
              event.preventDefault();
              const subject = subjectFrom(adding);
              if (!subject || busy) return;
              setAdding('');
              save(subject, role, `Shared with ${names.subject(subject)}.`);
            }}
          >
            <div className="min-w-0 flex-1 basis-48 space-y-1.5">
              <Label htmlFor="share-subject">Person or team</Label>
              <Select value={adding || null} disabled={busy} onValueChange={value => setAdding(value ?? '')}>
                <SelectTrigger id="share-subject" width="full">
                  <SelectValue>
                    {(() => {
                      const subject = adding ? subjectFrom(adding) : null;
                      return subject ? names.subject(subject) : 'Choose a person or team';
                    })()}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {people.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>People</SelectLabel>
                      {people.map(member => (
                        <SelectItem
                          key={member.membershipId}
                          value={key({ kind: 'individual', id: member.membershipId })}
                        >
                          {member.email ? `${member.name} (${member.email})` : member.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {teams.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Teams</SelectLabel>
                      {teams.map(team => (
                        <SelectItem key={team.id} value={key({ kind: 'team', id: team.id })}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="share-role">Access</Label>
              <Select
                value={role}
                disabled={busy}
                onValueChange={value => {
                  if (value) setRole(fileRoleSchema.parse(value));
                }}
              >
                <SelectTrigger id="share-role">
                  <SelectValue>{roleLabels[role]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {fileRoleSchema.options.map(option => (
                    <SelectItem key={option} value={option}>
                      {roleLabels[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" variant="outline" disabled={busy || !adding}>
              Share
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">Everyone in the workspace already has direct access.</p>
        )}
      </section>
      {groups.length > 0 && (
        <section aria-labelledby="inherited-access" className="space-y-2">
          <h3 id="inherited-access" className="text-sm font-medium text-foreground">
            Inherited from folders
          </h3>
          <p className="text-sm text-muted-foreground">
            Folder access applies to everything inside. Change it on the folder it comes from; it can’t be removed here.
          </p>
          {groups.map((group, index) => {
            const source = group[0]?.source;
            return (
              <div key={source?.kind === 'readable' ? source.id : `restricted-${index}`} className="rounded-lg border">
                <p className="truncate border-b px-3 py-2 text-sm text-foreground">
                  {source?.kind === 'readable' ? `From “${source.name}”` : 'From a folder you can’t open'}
                </p>
                <ul className="divide-y">
                  {group.map(entry => {
                    const label =
                      entry.kind === 'ownership'
                        ? (names.person(entry.owner.membershipId) ?? 'Workspace member')
                        : names.subject(entry.grant.subject);
                    return (
                      <li
                        key={entry.kind === 'ownership' ? 'owner' : key(entry.grant.subject)}
                        className="flex min-w-0 items-center justify-between gap-3 px-3 py-2"
                      >
                        <span className="min-w-0 truncate text-sm text-foreground" title={label}>
                          {label}
                        </span>
                        <span className="shrink-0 text-sm text-muted-foreground">
                          {entry.kind === 'ownership' ? 'Folder owner' : roleLabels[entry.grant.role]}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </section>
      )}
      <p className="text-sm text-muted-foreground">
        {audience.length === 1 ? 'Only 1 person can open this' : `${audience.length} people can open this`}, counting
        teams and folders: {audience.join(', ')}.
      </p>
    </>
  );
}
