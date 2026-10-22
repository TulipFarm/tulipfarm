import { useCallback, useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { Switch } from '@tulipfarm/sprout/switch';
import { DataList, DataListActions, DataListCell, DataListRow, DataListSecondary } from '@/components/data-list';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useModelAvailability, useModelAvailabilityReceipt, useModelChanges } from './queries';
import { UnsavedChanges } from '@/features/tables/feedback';
import { useSettingsCommand } from '@/features/settings/use-settings-command';
import { CommandFeedback } from '@/features/settings/command-feedback';
import { availabilityApi, type Availability, type AvailabilityCommand } from './availability-api';
import type { ModelCatalogFamily } from '@tulipfarm/config/model-catalog';
import { modelAvailabilityCommandSchema } from '@tulipfarm/agents/model-policy-contracts';
import { commandRecovery } from '@/features/settings/command-recovery';
import { ModelRead } from './read';
import { creditRates } from './credit-rates';
import { matchesModel } from './model-brand';
import { ModelLogo } from './model-logo';
import { SearchField } from '@tulipfarm/sprout/search-field';

export type AccessRowParts = { name: string; icon: ReactNode; notes: ReactNode; rates: ReactNode; control: ReactNode };

const modelHeadings = [
  'Model',
  { label: 'Rates', hint: 'Credits per 1M input / output tokens.' },
  { label: 'Fallback', hint: 'If a model is unavailable, chats switch to its fallback.' },
  { label: 'Access', hint: "Turned-off models can't be picked or used as a fallback." },
];

export function AccessRow({
  parts,
  fallback,
  below,
}: {
  parts: AccessRowParts;
  fallback?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <DataListRow aria-label={parts.name}>
      <DataListCell weight="strong" flow="line">
        {parts.icon}
        <span className="break-words">{parts.name}</span>
        <span className="flex flex-wrap gap-2 text-xs font-normal text-muted-foreground">{parts.notes}</span>
      </DataListCell>
      <DataListSecondary>{parts.rates}</DataListSecondary>
      <DataListCell>{fallback}</DataListCell>
      <DataListActions>{parts.control}</DataListActions>
      {below && <DataListCell span="full">{below}</DataListCell>}
    </DataListRow>
  );
}

export function ModelAvailability({
  userId,
  workspaceId,
  families,
  admin,
  concealed,
  writable,
  accessVersion,
  refreshAccess,
  renderRow,
}: {
  renderRow?: (family: ModelCatalogFamily, parts: AccessRowParts) => ReactNode;
  userId: string;
  workspaceId: string;
  families: ModelCatalogFamily[];
  admin: boolean;
  concealed: boolean;
  writable: boolean;
  accessVersion: number;
  refreshAccess: () => Promise<void>;
}) {
  const changes = useModelChanges();
  const api = useMemo(() => availabilityApi(workspaceId), [workspaceId]);
  const recovery = useMemo(
    () => commandRecovery({ userId, workspaceId, channel: 'availability', schema: modelAvailabilityCommandSchema }),
    [userId, workspaceId],
  );
  const confirmed = useRef(new Map<string, Availability>());
  const [draft, setDraft] = useState<AvailabilityCommand | null>(() => recovery.load());
  const [denied, setDenied] = useState(false);
  const [query, setQuery] = useState('');
  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.read(signal);
      if (signal.aborted) throw new Error('Availability read cancelled');
      setDenied(false);
      return {
        items: result.items.map(row => {
          const saved = confirmed.current.get(row.familyId);
          return saved && saved.revision > row.revision ? saved : row;
        }),
      };
    },
    [api],
  );
  const read = useModelAvailability(load, !concealed);
  const refresh = read.refresh;
  const version = useRef(accessVersion);
  useEffect(() => {
    if (
      !concealed &&
      version.current !== accessVersion &&
      read.state.kind !== 'loading' &&
      !(read.state.kind === 'ready' && read.state.refreshing)
    ) {
      version.current = accessVersion;
      void refresh();
    }
  }, [accessVersion, concealed, read.state, refresh]);
  const send = async (input: AvailabilityCommand) => {
    const result = await api.save(input, AbortSignal.timeout(15_000));
    void changes.policy();
    return result;
  };
  const receipt = useModelAvailabilityReceipt(api);
  const command = useSettingsCommand({
    send,
    receipt,
    recovery,
    onSaved: receipt => {
      confirmed.current.set(receipt.familyId, receipt);
      setDraft(null);
    },
    onDenied: () => {
      setDenied(true);
      void refreshAccess();
    },
  });
  const blocked =
    !admin ||
    concealed ||
    !writable ||
    denied ||
    read.state.kind !== 'ready' ||
    read.state.refreshing ||
    !!read.state.error;
  const conflict = command.state.kind === 'conflict';
  const listed = (items: Availability[]) => items.filter(row => families.some(family => family.id === row.familyId));
  const shown = (items: Availability[]) =>
    items.filter(row =>
      matchesModel(families.find(family => family.id === row.familyId)?.displayName ?? row.familyId, query),
    );
  return (
    <>
      <UnsavedChanges dirty={conflict} />
      {!concealed && (
        <section aria-labelledby="model-access-heading" className="space-y-2">
          <h2 id="model-access-heading" className="sr-only">
            Model access
          </h2>
          <ModelRead
            state={denied ? { kind: 'unavailable', status: 403 } : read.state}
            refresh={async () => {
              await refreshAccess();
              await refresh();
            }}
            label="model access"
          >
            {({ items: all }) => {
              const items = listed(all);
              return (
                <>
                  {!items.length && (
                    <StatePanel
                      kind="empty"
                      title="No model access policies listed"
                      description="Policies appear here after model families are configured."
                    />
                  )}
                  {!!items.length && items.every(row => !row.enabled) && (
                    <Alert>
                      <AlertDescription>
                        All model families are disabled. Model execution is unavailable until an admin enables an
                        available family. Your saved preferences remain unchanged.
                      </AlertDescription>
                    </Alert>
                  )}
                  {!!items.length && <SearchField label="Search models" value={query} onChange={setQuery} />}
                  {!!items.length && !shown(items).length && <NoModelMatch query={query} clear={() => setQuery('')} />}
                  {!!shown(items).length && (
                    <DataList aria-label="Models" columns="settings" headings={modelHeadings}>
                      {shown(items).map(row => {
                        const family = families.find(family => family.id === row.familyId);
                        const pending =
                          command.state.kind === 'sending' && command.state.command.familyId === row.familyId;
                        const name = family?.displayName ?? row.familyId;
                        const parts: AccessRowParts = {
                          name,
                          icon: <ModelLogo vendor={family?.vendor} size="sm" />,
                          notes: <>{pending && <span>Saving…</span>}</>,
                          rates: family && <span className="tabular-nums">{creditRates(family)}</span>,
                          control: admin ? (
                            <Switch
                              aria-label={`Allow ${name}`}
                              checked={row.enabled}
                              disabled={blocked || command.unresolved || conflict}
                              aria-busy={pending}
                              onCheckedChange={enabled => {
                                const input = {
                                  requestId: crypto.randomUUID(),
                                  familyId: row.familyId,
                                  enabled,
                                  expectedRevision: row.revision,
                                };
                                setDraft(input);
                                void command.submit(input);
                              }}
                            />
                          ) : (
                            <span>{row.enabled ? 'On' : 'Off'}</span>
                          ),
                        };
                        return family && renderRow ? (
                          <Fragment key={row.familyId}>{renderRow(family, parts)}</Fragment>
                        ) : (
                          <AccessRow key={row.familyId} parts={parts} />
                        );
                      })}
                    </DataList>
                  )}
                  {admin && conflict && draft && (
                    <div className="space-y-3">
                      <Alert variant="destructive">
                        <AlertDescription>
                          Another admin changed model access. Your intended change is retained. Reload model access,
                          review the current state, then apply your change deliberately.
                        </AlertDescription>
                      </Alert>
                      <Button
                        variant="outline"
                        disabled={command.busy || read.state.kind !== 'ready' || read.state.refreshing}
                        onClick={() => {
                          void refresh();
                          void refreshAccess();
                        }}
                      >
                        Reload model access
                      </Button>
                      <p>
                        Requested change: {draft.enabled ? 'enable' : 'disable'}{' '}
                        {families.find(family => family.id === draft.familyId)?.displayName ?? draft.familyId}.
                      </p>
                      <Button
                        disabled={
                          blocked ||
                          !items.some(row => row.familyId === draft.familyId && row.revision !== draft.expectedRevision)
                        }
                        onClick={() => {
                          const row = items.find(row => row.familyId === draft.familyId);
                          if (!row) return;
                          const input = { ...draft, requestId: crypto.randomUUID(), expectedRevision: row.revision };
                          setDraft(input);
                          void command.submit(input);
                        }}
                      >
                        Apply retained change
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setDraft(null);
                          command.reset();
                        }}
                      >
                        Discard change
                      </Button>
                    </div>
                  )}
                </>
              );
            }}
          </ModelRead>
        </section>
      )}
      <CommandFeedback
        state={command.state}
        check={command.check}
        retry={input => {
          if (!blocked) void command.submit(input);
        }}
        writable={!blocked}
      />
      {command.state.kind === 'saved' && (
        <p role="status" className="text-sm text-muted-foreground">
          Model access saved.
        </p>
      )}
    </>
  );
}

export function NoModelMatch({ query, clear }: { query: string; clear: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-sm text-muted-foreground">No models match “{query}”.</p>
      <Button variant="outline" size="sm" onClick={clear}>
        Clear search
      </Button>
    </div>
  );
}
