import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { MoreH } from 'reicon-react/icons/MoreH';
import { ShieldUser } from 'reicon-react/icons/ShieldUser';
import type { GovernanceSnapshot, PolicyScope } from '@tulipfarm/workspaces/governance-contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { RadioGroup, RadioGroupItem } from '@tulipfarm/sprout/radio-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Table } from '@tulipfarm/sprout/table';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import {
  joinList,
  permissionGroups,
  permissionInfo,
  permissionSummary,
  presetOf,
  presets,
  scopeKindLabel,
  scopeTarget,
  sortPermissions,
  sourceLabel,
  type PolicyPermission,
  type PolicyRow,
  type Preset,
  type TablePermission,
} from './policies';

/** A scope the editor can offer, with its display name. */
export type ScopeChoice = PolicyScope & { name: string };
export type SaveResult = { ok: true } | { ok: false; message: string };

export function scopeChoices(data: Pick<GovernanceSnapshot, 'tables' | 'teams' | 'teamNames'>) {
  const teams = new Map([...data.teamNames, ...data.teams].map(team => [team.id, team.name]));
  return {
    tables: data.tables
      .map(table => ({ kind: 'table' as const, id: table.id, name: table.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    teams: [...teams]
      .map(([id, name]) => ({ kind: 'collection' as const, id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const scopeValue = (scope: PolicyScope) => `${scope.kind}:${scope.id}`;

/**
 * Chooses a scope, then a preset or individual permissions. Saving with no permissions is blocked;
 * removing a policy is a separate, confirmed action.
 */
export function PolicyEditor({
  open,
  onOpenChange,
  subject,
  choices,
  initial,
  existing,
  save,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names who receives the access, as in "Add a policy for QA Readers". */
  subject: string;
  choices: { tables: ScopeChoice[]; teams: ScopeChoice[] };
  /** Editing keeps the scope fixed. */
  initial: { scope: ScopeChoice; permissions: PolicyPermission[] } | null;
  /** Permissions already held per scope, so picking such a scope edits that policy instead of duplicating it. */
  existing: Map<string, PolicyPermission[]>;
  save: (scope: ScopeChoice, permissions: PolicyPermission[]) => Promise<SaveResult>;
}) {
  const [scopeKey, setScopeKey] = useState('');
  const [permissions, setPermissions] = useState<PolicyPermission[]>([]);
  const [preset, setPreset] = useState<Preset>('reader');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Saving fills in the scope's existing permissions; keep the title the person saw when they pressed save.
  const [savingTitle, setSavingTitle] = useState<string | null>(null);
  const all = [...choices.tables, ...choices.teams];
  const scope = initial?.scope ?? all.find(choice => scopeValue(choice) === scopeKey);
  useEffect(() => {
    if (!open) return;
    setFailure(null);
    setPending(false);
    setSavingTitle(null);
    if (initial) {
      setScopeKey(scopeValue(initial.scope));
      setPermissions(initial.permissions);
      setPreset(presetOf(initial.permissions));
    } else {
      setScopeKey('');
      setPermissions([...presets.reader.permissions]);
      setPreset('reader');
    }
  }, [open]);
  function chooseScope(value: string) {
    setScopeKey(value);
    setFailure(null);
    const chosen = all.find(choice => scopeValue(choice) === value);
    if (!chosen) return;
    const held = existing.get(value);
    if (chosen.kind === 'collection') setPermissions(['table.create']);
    else if (held?.length) {
      setPermissions(held);
      setPreset(presetOf(held));
    } else {
      setPermissions([...presets[preset === 'custom' ? 'reader' : preset].permissions]);
      if (preset === 'custom') setPreset('reader');
    }
  }
  function choosePreset(value: Preset) {
    setPreset(value);
    if (value !== 'custom') setPermissions([...presets[value].permissions]);
  }
  function toggle(permission: TablePermission, on: boolean) {
    setPreset('custom');
    setPermissions(current =>
      sortPermissions(on ? [...new Set([...current, permission])] : current.filter(value => value !== permission)),
    );
  }
  const editing = initial !== null || (scope ? (existing.get(scopeValue(scope))?.length ?? 0) > 0 : false);
  const live = editing ? `Edit policy for ${subject}` : `Add a policy for ${subject}`;
  const title = savingTitle ?? live;
  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        if (!pending) onOpenChange(value);
      }}
    >
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            A policy gives permissions on one table, or lets {subject} create tables owned by a team.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col gap-4"
          onSubmit={async event => {
            event.preventDefault();
            // The dialog portals out of the DOM but React still bubbles submit to an enclosing form.
            event.stopPropagation();
            if (pending || !scope || !permissions.length) return;
            setPending(true);
            setSavingTitle(title);
            setFailure(null);
            const result = await save(scope, permissions);
            setPending(false);
            if (result.ok) onOpenChange(false);
            else {
              setSavingTitle(null);
              setFailure(result.message);
            }
          }}
        >
          <DialogBody>
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <Label htmlFor="policy-scope">Applies to</Label>
                {initial ? (
                  <p id="policy-scope" className="font-medium wrap-anywhere">
                    {scopeTarget(initial.scope)}
                  </p>
                ) : (
                  <Select value={scopeKey} onValueChange={value => chooseScope(value ?? '')} disabled={pending}>
                    <SelectTrigger id="policy-scope">
                      <SelectValue>{scope ? scopeTarget(scope) : 'Choose a table or team'}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {choices.tables.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>Tables</SelectLabel>
                          {choices.tables.map(choice => (
                            <SelectItem key={scopeValue(choice)} value={scopeValue(choice)}>
                              {choice.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                      {choices.teams.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>Create tables owned by a team</SelectLabel>
                          {choices.teams.map(choice => (
                            <SelectItem key={scopeValue(choice)} value={scopeValue(choice)}>
                              New tables owned by {choice.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                )}
                {!initial && !all.length && (
                  <p className="text-sm text-muted-foreground">There are no tables or teams to choose yet.</p>
                )}
              </div>
              {scope?.kind === 'collection' && (
                <div className="flex items-start gap-3">
                  <Checkbox id="policy-table-create" checked disabled />
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="policy-table-create">{permissionInfo['table.create'].label}</Label>
                    <p className="text-sm text-muted-foreground">
                      Create tables that {scope.name} owns. Owning a table doesn’t give access to its rows.
                    </p>
                  </div>
                </div>
              )}
              {scope?.kind === 'table' && (
                <>
                  <RadioGroup
                    aria-labelledby="policy-preset-label"
                    value={preset}
                    onValueChange={value => choosePreset(value as Preset)}
                    disabled={pending}
                  >
                    <div className="flex flex-col gap-3">
                      <p id="policy-preset-label" className="text-sm font-medium">
                        Permissions
                      </p>
                      {(Object.keys(presets) as Preset[]).map(key => (
                        <div key={key} className="flex items-start gap-3">
                          <RadioGroupItem id={`policy-preset-${key}`} value={key} />
                          <div className="flex flex-col gap-0.5">
                            <Label htmlFor={`policy-preset-${key}`}>{presets[key].label}</Label>
                            <p className="text-sm text-muted-foreground">{presets[key].description}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </RadioGroup>
                  {permissionGroups.map(group => {
                    const held = group.permissions.filter(permission => permissions.includes(permission));
                    const id = `policy-group-${group.label.toLowerCase()}`;
                    return (
                      <fieldset
                        key={group.label}
                        disabled={pending}
                        className="flex flex-col gap-3 rounded-md border p-4"
                      >
                        <legend className="sr-only">{group.label} permissions</legend>
                        <div className="flex items-center gap-3">
                          <Checkbox
                            id={id}
                            checked={held.length === group.permissions.length}
                            indeterminate={held.length > 0 && held.length < group.permissions.length}
                            onCheckedChange={on => {
                              setPreset('custom');
                              setPermissions(current =>
                                sortPermissions(
                                  on
                                    ? [...new Set([...current, ...group.permissions])]
                                    : current.filter(
                                        value => !(group.permissions as PolicyPermission[]).includes(value),
                                      ),
                                ),
                              );
                            }}
                            aria-label={`All ${group.label.toLowerCase()} permissions on ${scope.name}`}
                          />
                          <Label htmlFor={id}>{group.label}</Label>
                          <Badge variant="secondary">
                            {held.length}/{group.permissions.length}
                          </Badge>
                        </div>
                        <div className="flex flex-col gap-3 ps-7">
                          {group.permissions.map(permission => (
                            <div key={permission} className="flex items-start gap-3">
                              <Checkbox
                                id={`policy-${permission}`}
                                checked={permissions.includes(permission)}
                                onCheckedChange={on => toggle(permission, on)}
                                aria-describedby={`policy-${permission}-help`}
                              />
                              <div className="flex flex-col gap-0.5">
                                <Label htmlFor={`policy-${permission}`}>{permissionInfo[permission].label}</Label>
                                <p id={`policy-${permission}-help`} className="text-sm text-muted-foreground">
                                  {permissionInfo[permission].description}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </fieldset>
                    );
                  })}
                  {!permissions.length && (
                    <p role="status" className="text-sm text-muted-foreground">
                      Choose at least one permission. To take all access away, remove the policy instead.
                    </p>
                  )}
                </>
              )}
              {failure && (
                <Alert variant="destructive">
                  <AlertDescription>{failure}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !scope || !permissions.length} aria-busy={pending}>
              {pending ? 'Saving…' : editing ? 'Save policy' : 'Add policy'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The shared access-policy table on member and team detail. Rows the viewer can't change, such as
 * team-granted access on a member, show where to change them instead of a menu.
 */
export function PolicyTable({
  label,
  subject,
  rows,
  workspaceSlug,
  editable,
  showSource = true,
  onEdit,
  onRemove,
  empty,
}: {
  label: string;
  subject: string;
  rows: PolicyRow[];
  workspaceSlug: string;
  editable: (row: PolicyRow) => boolean;
  showSource?: boolean;
  onEdit: (row: PolicyRow) => void;
  onRemove: (row: PolicyRow) => Promise<SaveResult>;
  empty: ReactNode;
}) {
  const [removing, setRemoving] = useState<PolicyRow | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!rows.length) return <>{empty}</>;
  type Row = PolicyRow & { scopeKind: string; target: string; summary: string; grantedBy: string };
  const data: Row[] = rows.map(row => ({
    ...row,
    scopeKind: scopeKindLabel(row.scope),
    target: scopeTarget(row.scope),
    summary: permissionSummary(row.permissions),
    grantedBy: sourceLabel(row.source),
  }));
  return (
    <>
      <Table
        aria-label={label}
        narrow="stack"
        data={data}
        getRowId={row => row.key}
        rowLabel={row => row.target}
        columns={[
          { key: 'scopeKind', header: 'Scope', sort: true },
          {
            key: 'target',
            header: 'Applies to',
            sort: true,
            cell: row => <span className="font-medium wrap-anywhere">{row.target}</span>,
          },
          {
            key: 'summary',
            header: 'Permissions',
            cell: row => (
              <span className="flex flex-col gap-0.5">
                <span>{row.summary}</span>
                {presetOf(row.permissions) !== 'custom' && row.scope.kind === 'table' && (
                  <span className="text-xs text-muted-foreground">
                    {row.permissions.map(permission => permissionInfo[permission].label).join(', ')}
                  </span>
                )}
              </span>
            ),
          },
          ...(showSource
            ? [
                {
                  key: 'grantedBy' as const,
                  header: 'Granted by',
                  sort: true,
                  cell: (row: Row) =>
                    row.source.kind === 'team' ? (
                      <span className="underline-offset-4 hover:underline">
                        <Link to="/$workspaceSlug/teams/$teamId" params={{ workspaceSlug, teamId: row.source.teamId }}>
                          {row.grantedBy}
                        </Link>
                      </span>
                    ) : (
                      row.grantedBy
                    ),
                },
              ]
            : []),
        ]}
        actions={row =>
          editable(row) ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for the policy on ${row.target} for ${subject}`}
                  />
                }
              >
                <MoreH size={16} aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  aria-label={`Edit the policy on ${row.target} for ${subject}`}
                  onClick={() => onEdit(row)}
                >
                  Edit policy on {row.target}
                </DropdownMenuItem>
                <DropdownMenuItem
                  aria-label={`Remove the policy on ${row.target} for ${subject}`}
                  variant="destructive"
                  onClick={() => {
                    setFailure(null);
                    setRemoving(row);
                  }}
                >
                  Remove policy on {row.target}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : row.source.kind === 'admin' ? (
            <span className="sr-only">Comes with the Admin role and can’t be changed here</span>
          ) : row.source.kind === 'team' ? (
            <span className="sr-only">To change this, edit the team {row.source.teamName}</span>
          ) : null
        }
      />
      <AlertDialog
        open={removing !== null}
        onOpenChange={open => {
          if (!open && !pending) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            Remove the policy on {removing ? scopeTarget(removing.scope) : ''} for {subject}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This takes away{' '}
            {removing ? joinList(sortPermissions(removing.permissions).map(p => permissionInfo[p].label)) : ''} on{' '}
            {removing ? scopeTarget(removing.scope) : ''} from {subject}. Access from teams and other policies stays.
          </AlertDialogDescription>
          {failure && (
            <Alert variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={pending}
              aria-busy={pending}
              onClick={async () => {
                if (!removing || pending) return;
                setPending(true);
                const result = await onRemove(removing);
                setPending(false);
                if (result.ok) setRemoving(null);
                else setFailure(result.message);
              }}
            >
              Remove policy
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function NoPolicies({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <StatePanel kind="empty" heading="h3" icon={ShieldUser} title={title} description={description}>
      {action}
    </StatePanel>
  );
}
