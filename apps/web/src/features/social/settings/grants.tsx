import { useId, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { SocialRequestError } from '@/lib/social';
import { settingsError, type Principal, type PrincipalSet } from './labels';

export type GrantRole<K extends string> = { key: K; label: string; verb: string };
export type GrantDraft<K extends string> = Record<K, PrincipalSet>;

type ViewProps<K extends string> = {
  title: string;
  note?: string | undefined;
  roles: readonly GrantRole<K>[];
  members: readonly Principal[];
  teams: readonly Principal[];
  value: GrantDraft<K>;
  managerRole: K;
  conflict: boolean;
  busy: boolean;
  message: { text: string; ok: boolean } | null;
  onToggle: (role: K, kind: keyof PrincipalSet, id: string, checked: boolean) => void;
  onSave: () => void;
  onReload: () => void;
};

/** Members and teams against each grant, with the stale-version and last-manager guards (PRODUCT 9–11). */
export function GrantsView<K extends string>(props: ViewProps<K>) {
  const { title, note, roles, value, managerRole, conflict, busy, message } = props;
  const heading = useId();
  const listed = (kind: keyof PrincipalSet, known: readonly Principal[], other: string) => {
    const ids = new Set(roles.flatMap(role => value[role.key][kind]));
    return [...known, ...[...ids].filter(id => !known.some(item => item.id === id)).map(id => ({ id, name: other }))];
  };
  const rows = [
    ...listed('memberIds', props.members, 'Former or unlisted member').map(item => ({
      ...item,
      kind: 'memberIds' as const,
    })),
    ...listed('teamIds', props.teams, 'Team you are not in').map(item => ({ ...item, kind: 'teamIds' as const })),
  ];
  const managers = value[managerRole].memberIds.length + value[managerRole].teamIds.length;
  return (
    <section aria-labelledby={heading} className="space-y-3">
      <h4 id={heading} className="font-medium">
        {title}
      </h4>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      <fieldset disabled={busy || conflict} className="min-w-0">
        <legend className="sr-only">{title}</legend>
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map(row => (
            <li key={`${row.kind}:${row.id}`} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <p className="min-w-0 text-sm">
                <span className="font-medium">{row.name}</span>
                <span className="ml-2 text-muted-foreground">{row.kind === 'teamIds' ? 'Team' : 'Member'}</span>
              </p>
              <div className="flex flex-wrap gap-4">
                {roles.map(role => (
                  <Label key={role.key}>
                    <Checkbox
                      aria-label={`Allow ${row.name} to ${role.verb}`}
                      checked={value[role.key][row.kind].includes(row.id)}
                      onCheckedChange={checked => props.onToggle(role.key, row.kind, row.id, checked === true)}
                    />
                    {role.label}
                  </Label>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </fieldset>
      {managers === 0 && !conflict && (
        <Alert variant="destructive">
          <AlertDescription>Keep at least one manager, or no one can change these grants.</AlertDescription>
        </Alert>
      )}
      {conflict && (
        <Alert variant="destructive">
          <AlertDescription>
            Someone else changed these grants after you opened them. Your changes are not saved. Reload to see the
            current grants, then make your changes again.
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert variant={message.ok ? 'default' : 'destructive'}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || conflict || managers === 0}
          aria-busy={busy}
          aria-label={`Save ${title.toLowerCase()}`}
          onClick={props.onSave}
        >
          Save
        </Button>
        <Button variant="outline" disabled={busy} aria-label={`Reload ${title.toLowerCase()}`} onClick={props.onReload}>
          Reload
        </Button>
      </div>
    </section>
  );
}

/**
 * Edits one grant set. Saving sends the version the edit began from; if someone else saved first, the edit is kept
 * on screen, marked stale and never resent, until the person reloads.
 */
export function GrantsEditor<K extends string>({
  saved,
  save,
  refresh,
  conflictCodes,
  title,
  note,
  roles,
  members,
  teams,
  managerRole,
}: Omit<ViewProps<K>, 'value' | 'conflict' | 'busy' | 'message' | 'onToggle' | 'onSave' | 'onReload'> & {
  saved: { version: number; value: GrantDraft<K> };
  save: (value: GrantDraft<K>, expectedVersion: number) => Promise<unknown>;
  refresh: () => Promise<unknown>;
  conflictCodes: readonly string[];
}) {
  const [edit, setEdit] = useState<{ basedOn: number; value: GrantDraft<K> } | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const lock = useRef(false);
  const value = edit?.value ?? saved.value;
  const conflict = edit !== null && (stale || saved.version > edit.basedOn);
  const toggle = (role: K, kind: keyof PrincipalSet, id: string, checked: boolean) => {
    const current = value[role][kind].filter(item => item !== id);
    setMessage(null);
    setEdit({
      basedOn: edit?.basedOn ?? saved.version,
      value: { ...value, [role]: { ...value[role], [kind]: checked ? [...current, id] : current } },
    });
  };
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const onSave = () =>
    void run(async () => {
      if (!edit || conflict) return;
      setMessage(null);
      try {
        await save(edit.value, edit.basedOn);
        await refresh().catch(() => {});
        setEdit(null);
        setMessage({ text: 'Grants saved.', ok: true });
      } catch (error) {
        if (error instanceof SocialRequestError && conflictCodes.includes(error.code)) {
          setStale(true);
          await refresh().catch(() => {});
        } else setMessage({ text: settingsError(error), ok: false });
      }
    });
  const onReload = () =>
    void run(async () => {
      setMessage(null);
      try {
        await refresh();
        setEdit(null);
        setStale(false);
      } catch (error) {
        setMessage({ text: settingsError(error), ok: false });
      }
    });
  return (
    <GrantsView
      title={title}
      note={note}
      roles={roles}
      members={members}
      teams={teams}
      managerRole={managerRole}
      value={value}
      conflict={conflict}
      busy={busy}
      message={message}
      onToggle={toggle}
      onSave={onSave}
      onReload={onReload}
    />
  );
}
