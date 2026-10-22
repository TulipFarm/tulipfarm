import { useRef, useState } from 'react';
import { Check } from 'reicon-react/icons/Check';
import type { MovePreview } from '@tulipfarm/files/contracts';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { failedWrite, TableRequestError } from '@/features/tables/request-state';
import { errorMessage, roleLabels, useFilesChanges, type FilesApi, type FileSummary } from './api';
import { FolderBrowser, useFolderPlace, type FolderDestination, type FolderPlace } from './folder-browser';
import { directoryNames, useDirectory, type FinalFocus } from './sharing';

export type MoveDestination = FolderDestination;
/** One item's progress through review and commit. A refreshed preview replaced one the server rejected as stale. */
type Status =
  | { kind: 'checking' }
  | { kind: 'ready'; preview: MovePreview; refreshed: boolean }
  | { kind: 'blocked'; message: string }
  | { kind: 'moving' }
  | { kind: 'moved' }
  | { kind: 'failed'; message: string };
type Step = { kind: 'browse' } | { kind: 'review'; destination: MoveDestination };
export type MoveOutcome = {
  destination: MoveDestination;
  moved: FileSummary[];
  failed: { item: FileSummary; message: string }[];
};
type Names = ReturnType<typeof directoryNames>;

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** `Restore` brings a Trash item to a folder the restorer chooses when its original folder is trashed or no longer accepts it; the server clears its trash mark as part of the move. */
export function MoveDialog({
  api,
  items,
  membershipId,
  finalFocus,
  onClose,
  verb = 'Move',
}: {
  api: FilesApi;
  items: FileSummary[];
  membershipId: string;
  finalFocus?: FinalFocus;
  onClose: (outcome: MoveOutcome | null) => void;
  verb?: 'Move' | 'Restore';
}) {
  const [place, setPlace] = useState<FolderPlace>({ section: 'mine', folder: null });
  const [step, setStep] = useState<Step>({ kind: 'browse' });
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const latest = useRef(statuses);
  const [attempted, setAttempted] = useState(false);
  const { changed } = useFilesChanges();
  const directory = useDirectory(api, items[0]?.id);
  const names = directoryNames(directory.state.kind === 'ready' ? directory.state.data : undefined, membershipId);
  const set = (id: string, status: Status) => {
    latest.current = { ...latest.current, [id]: status };
    setStatuses(latest.current);
  };
  const busy = Object.values(statuses).some(status => status.kind === 'checking' || status.kind === 'moving');
  const ready = items.filter(item => statuses[item.id]?.kind === 'ready');
  const title = items.length === 1 ? `${verb} “${items[0]?.name}”` : `${verb} ${plural(items.length, 'item')}`;

  async function check(item: FileSummary, destination: MoveDestination, refreshed: boolean) {
    set(item.id, { kind: 'checking' });
    try {
      set(item.id, { kind: 'ready', preview: await api.previewMove(item.id, destination.parentId), refreshed });
    } catch (error) {
      set(item.id, {
        kind: 'blocked',
        message: errorMessage(error, 'Couldn’t check how access changes. Check your connection and try again.'),
      });
    }
  }
  async function review(destination: MoveDestination) {
    setStep({ kind: 'review', destination });
    await Promise.all(items.map(item => check(item, destination, false)));
  }
  async function commit(destination: MoveDestination) {
    setAttempted(true);
    for (const item of items) {
      const status = latest.current[item.id];
      if (status?.kind !== 'ready') continue;
      set(item.id, { kind: 'moving' });
      try {
        await api.move(item.id, destination.parentId, status.preview.fingerprint);
        set(item.id, { kind: 'moved' });
      } catch (error) {
        if (error instanceof TableRequestError && error.code === 'file-conflict') await check(item, destination, true);
        else {
          const outcome = failedWrite(null, error);
          set(item.id, {
            kind: 'failed',
            message:
              outcome.kind === 'rejected'
                ? `${outcome.message} It stays where it was.`
                : 'We couldn’t confirm this move. Check where the item is before moving it again.',
          });
        }
      }
    }
    await changed();
    if (items.every(item => latest.current[item.id]?.kind === 'moved')) onClose(outcome(destination));
  }
  function outcome(destination: MoveDestination): MoveOutcome {
    const moved = items.filter(item => latest.current[item.id]?.kind === 'moved');
    return {
      destination,
      moved,
      failed: items
        .filter(item => !moved.includes(item))
        .map(item => {
          const status = latest.current[item.id];
          return {
            item,
            message:
              status?.kind === 'failed' || status?.kind === 'blocked'
                ? status.message
                : status?.kind === 'ready' && status.refreshed
                  ? 'Access changed before it moved. It wasn’t moved.'
                  : 'It wasn’t moved.',
          };
        }),
    };
  }
  const close = () => {
    if (!busy) onClose(attempted && step.kind === 'review' ? outcome(step.destination) : null);
  };

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) close();
      }}
    >
      <DialogContent size="form" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>
            <span className="wrap-anywhere">{title}</span>
          </DialogTitle>
          <DialogDescription>
            {step.kind === 'browse'
              ? verb === 'Restore'
                ? 'Its original folder is in Trash, or you can no longer add to it. Choose where to put it instead. Links stay the same.'
                : 'Choose a folder. Links stay the same after a move.'
              : `Review who gains or loses access in ${step.destination.label}. Direct sharing stays with each item; folder access follows the new location.`}
          </DialogDescription>
        </DialogHeader>
        {step.kind === 'browse' ? (
          <Browser
            verb={verb}
            api={api}
            items={items}
            membershipId={membershipId}
            place={place}
            setPlace={setPlace}
            review={destination => void review(destination)}
            cancel={close}
          />
        ) : (
          <>
            <div className="-mx-4 min-h-0 overflow-y-auto px-4 pb-1">
              <p role="status" className="sr-only">
                {busy
                  ? 'Working…'
                  : `${plural(items.filter(item => statuses[item.id]?.kind === 'moved').length, 'item')} moved.`}
              </p>
              <ul aria-label="Items to move" className="divide-y rounded-lg border">
                {items.map(item => (
                  <li key={item.id} className="space-y-1 px-3 py-2">
                    <p className="truncate text-sm font-medium text-foreground" title={item.name}>
                      {item.name}
                    </p>
                    <ItemStatus
                      status={statuses[item.id] ?? { kind: 'checking' }}
                      names={names}
                      retry={() => void check(item, step.destination, false)}
                    />
                  </li>
                ))}
              </ul>
            </div>
            <DialogFooter>
              {!attempted && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    latest.current = {};
                    setStatuses({});
                    setStep({ kind: 'browse' });
                  }}
                >
                  Choose another folder
                </Button>
              )}
              <Button variant="outline" disabled={busy} onClick={close}>
                {attempted ? 'Close' : 'Cancel'}
              </Button>
              {(!attempted || ready.length > 0) && (
                <Button
                  disabled={busy || ready.length === 0}
                  aria-busy={busy}
                  onClick={() => void commit(step.destination)}
                >
                  {busy
                    ? 'Working…'
                    : ready.some(item => {
                          const status = statuses[item.id];
                          return status?.kind === 'ready' && status.refreshed;
                        })
                      ? `${verb} ${plural(ready.length, 'item')} with updated access`
                      : `${verb} ${plural(ready.length, 'item')}`}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Browser({
  verb,
  api,
  items,
  membershipId,
  place,
  setPlace,
  review,
  cancel,
}: {
  verb: 'Move' | 'Restore';
  api: FilesApi;
  items: FileSummary[];
  membershipId: string;
  place: FolderPlace;
  setPlace: (place: FolderPlace) => void;
  review: (destination: MoveDestination) => void;
  cancel: () => void;
}) {
  const location = useFolderPlace(api, place);
  const { current, destination } = location;
  const unchanged = destination !== null && items.every(item => item.parentId === destination.parentId);
  const hint =
    place.folder === null && place.section === 'shared'
      ? 'Open a shared folder to move items into it.'
      : current?.role === 'viewer'
        ? 'You can view this folder but can’t add to it.'
        : unchanged
          ? items.length === 1
            ? 'The item is already here.'
            : 'These items are already here.'
          : destination?.parentId === null && items.some(item => item.creatorMembershipId !== membershipId)
            ? 'Items you don’t own go to the top level of their owner’s files.'
            : null;

  return (
    <>
      <div className="-mx-4 min-h-0 space-y-3 overflow-y-auto px-4 pb-1">
        <FolderBrowser
          place={place}
          setPlace={setPlace}
          location={location}
          exclude={new Set(items.map(item => item.id))}
          unchanged="Nothing has moved."
        />
      </div>
      <DialogFooter>
        {hint && <p className="text-sm text-muted-foreground sm:mr-auto sm:self-center">{hint}</p>}
        <Button variant="outline" onClick={cancel}>
          Cancel
        </Button>
        <Button
          disabled={!destination || unchanged}
          onClick={() => {
            if (destination) review(destination);
          }}
        >
          {destination ? `Review ${verb.toLowerCase()} to ${destination.label}` : `Review ${verb.toLowerCase()}`}
        </Button>
      </DialogFooter>
    </>
  );
}

function ItemStatus({ status, names, retry }: { status: Status; names: Names; retry: () => void }) {
  if (status.kind === 'checking') return <p className="text-sm text-muted-foreground">Checking how access changes…</p>;
  if (status.kind === 'moving') return <p className="text-sm text-muted-foreground">Moving…</p>;
  if (status.kind === 'moved')
    return (
      <p className="flex items-center gap-1.5 text-sm text-foreground">
        <Check size={14} aria-hidden="true" />
        Moved
      </p>
    );
  if (status.kind === 'failed') return <p className="text-sm text-destructive">{status.message}</p>;
  if (status.kind === 'blocked')
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-destructive">{status.message}</p>
        <Button variant="outline" size="sm" onClick={retry}>
          Check again
        </Button>
      </div>
    );
  return (
    <div className="space-y-1">
      {status.refreshed && (
        <p className="text-sm text-warning">
          Access changed since you reviewed it. Check the update below, then move again.
        </p>
      )}
      <AudienceChange preview={status.preview} names={names} />
    </div>
  );
}

/** Summarizes how the moved item's audience changes, and how many items inside it change too. */
export function AudienceChange({ preview, names }: { preview: MovePreview; names: Names }) {
  const self = preview.subtree.find(entry => entry.item.kind === 'readable' && entry.item.id === preview.source.id);
  if (!self) return null;
  const before = new Map(self.before.audience.map(entry => [entry.membershipId, entry.role]));
  const after = new Map(self.after.audience.map(entry => [entry.membershipId, entry.role]));
  const who = (ids: string[]) => {
    const known = ids.flatMap(id => names.person(id) ?? []);
    return known.length === ids.length
      ? known.sort((a, b) => a.localeCompare(b)).join(', ')
      : plural(ids.length, 'person', 'people');
  };
  const gained = [...after.keys()].filter(id => !before.has(id));
  const lost = [...before.keys()].filter(id => !after.has(id));
  const changed = [...after].filter(([id, role]) => before.has(id) && before.get(id) !== role);
  const inside = preview.subtree.filter(
    entry => entry !== self && JSON.stringify(entry.before.audience) !== JSON.stringify(entry.after.audience),
  ).length;
  const lines = [
    gained.length ? `Gains access: ${who(gained)}` : null,
    lost.length ? `Loses access: ${who(lost)}` : null,
    ...changed.map(([id, role]) => `${names.person(id) ?? 'One person'} changes to ${roleLabels[role].toLowerCase()}`),
    inside ? `Access also changes for ${plural(inside, 'item')} inside` : null,
  ].filter(line => line !== null);
  if (!lines.length) return <p className="text-sm text-muted-foreground">Who can open it stays the same.</p>;
  return (
    <ul className="space-y-0.5 text-sm text-foreground">
      {lines.map(line => (
        <li key={line}>{line}.</li>
      ))}
    </ul>
  );
}
