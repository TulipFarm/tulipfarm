import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { modelPolicyCommandSchema } from '@tulipfarm/agents/model-policy-contracts';
import { commandRecovery } from '@/features/settings/command-recovery';
import type { ModelCatalogFamily } from '@tulipfarm/config/model-catalog';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { UnsavedChanges } from '@/features/tables/feedback';
import { TableRequestError } from '@/features/tables/request-state';
import { useModelChanges, useModelReceipt, useModelRule } from './queries';
import { type modelApi, type ModelPolicyCommand, type ModelPolicyReceipt, type ModelPolicyRule } from './api';
import { ModelRead } from './read';
import { AccessRow, type AccessRowParts } from './availability';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'sending'; command: ModelPolicyCommand }
  | { kind: 'uncertain'; command: ModelPolicyCommand }
  | { kind: 'conflict' }
  | { kind: 'rejected'; message: string }
  | { kind: 'saved' };
type Draft = { base: ModelPolicyRule; target: string | null };
type ReceiptStatus = { kind: 'found'; receipt: ModelPolicyReceipt } | { kind: 'missing' };

export function FallbackRule({
  api,
  userId,
  workspaceId,
  source,
  families,
  admin,
  writable,
  concealed,
  accessVersion,
  refreshAccess,
  row,
}: {
  row: AccessRowParts;
  api: ReturnType<typeof modelApi>;
  userId: string;
  workspaceId: string;
  source: ModelCatalogFamily;
  families: ModelCatalogFamily[];
  admin: boolean;
  writable: boolean;
  concealed: boolean;
  accessVersion: number;
  refreshAccess: () => Promise<void>;
}) {
  const changes = useModelChanges();
  const recovery = useMemo(
    () =>
      commandRecovery({ userId, workspaceId, channel: 'fallback', scope: source.id, schema: modelPolicyCommandSchema }),
    [userId, workspaceId, source.id],
  );
  const [restored] = useState(() => recovery.load());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [save, setSave] = useState<SaveState>(() =>
    restored ? { kind: 'uncertain', command: restored } : { kind: 'idle' },
  );
  const [denial, setDenial] = useState<{ version: number; status: 401 | 403 | 404 } | null>(null);
  const currentAccessVersion = useRef(accessVersion);
  useEffect(() => {
    currentAccessVersion.current = accessVersion;
  }, [accessVersion]);
  const ruleAccessVersion = useRef(accessVersion);
  const latestRule = useRef<ModelPolicyRule | null>(null);
  const rebase = useRef(false);
  const active = useRef<AbortController | null>(null);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const version = currentAccessVersion.current;
      ruleAccessVersion.current = version;
      let rule: ModelPolicyRule;
      try {
        rule = await api.rule(source.id, signal);
      } catch (error) {
        if (
          !signal.aborted &&
          error instanceof TableRequestError &&
          (error.status === 401 || error.status === 403 || error.status === 404)
        )
          setDenial({ version, status: error.status });
        throw error;
      }
      if (!signal.aborted) {
        setDenial(previous => (previous && version > previous.version ? null : previous));
        if (latestRule.current && latestRule.current.revision > rule.revision) rule = latestRule.current;
        else latestRule.current = rule;
      }
      return rule;
    },
    [api, source.id, restored],
  );
  const read = useModelRule(source.id, load, !concealed);
  useEffect(() => {
    if (read.state.kind !== 'ready' || read.state.refreshing || read.state.error) return;
    const rule = read.state.data;
    const acceptLatest = rebase.current;
    setDraft(previous =>
      previous
        ? acceptLatest
          ? { ...previous, base: rule }
          : previous
        : { base: rule, target: restored ? restored.targetFamilyId : rule.targetFamilyId },
    );
    if (acceptLatest) {
      setSave({ kind: 'idle' });
      rebase.current = false;
    }
  }, [read.state, restored]);
  const canReconcile =
    !concealed &&
    !denial &&
    admin &&
    writable &&
    read.state.kind === 'ready' &&
    !read.state.refreshing &&
    !read.state.error;
  const refreshRule = read.refresh;
  useEffect(() => {
    if (
      concealed ||
      ruleAccessVersion.current === accessVersion ||
      read.state.kind === 'loading' ||
      (read.state.kind === 'ready' && read.state.refreshing)
    )
      return;
    void refreshRule();
  }, [concealed, accessVersion, read.state, refreshRule]);
  const command = save.kind === 'uncertain' ? save.command : null;
  const loadReceipt = useCallback(
    async (signal: AbortSignal): Promise<ReceiptStatus> => {
      if (!command) throw new Error('No uncertain command');
      try {
        return { kind: 'found', receipt: await api.command(command, signal) };
      } catch (error) {
        if (!signal.aborted && error instanceof TableRequestError && (error.status === 401 || error.status === 403))
          setDenial({ version: currentAccessVersion.current, status: error.status });
        if (error instanceof TableRequestError && error.status === 404) return { kind: 'missing' };
        throw error;
      }
    },
    [api, command, accessVersion],
  );
  const receipt = useModelReceipt(command, accessVersion, loadReceipt, command !== null && canReconcile);
  useEffect(() => {
    if (!canReconcile || !command || receipt.state.kind !== 'ready' || receipt.state.data.kind !== 'found') return;
    const saved = receipt.state.data.receipt;
    if (!latestRule.current || saved.revision > latestRule.current.revision) latestRule.current = saved;
    setDraft({ base: saved, target: saved.targetFamilyId });
    setSave({ kind: 'saved' });
    recovery.clear();
    void changes.policy(source.id);
  }, [canReconcile, command, receipt.state, changes, source.id, recovery]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!concealed && admin && read.state.kind !== 'unavailable') return;
    rebase.current = false;
    active.current?.abort();
    active.current = null;
    setSave(previous => (previous.kind === 'sending' ? { kind: 'uncertain', command: previous.command } : previous));
  }, [concealed, admin, read.state.kind]);

  async function submit(input: ModelPolicyCommand) {
    if (active.current || !canReconcile) return;
    try {
      recovery.save(input);
    } catch {
      if (save.kind !== 'uncertain')
        setSave({
          kind: 'rejected',
          message:
            'Could not keep recovery information in this tab. No request was sent. Allow session storage before trying again.',
        });
      return;
    }
    const recovering = save.kind === 'uncertain';
    const controller = new AbortController();
    active.current = controller;
    setSave({ kind: 'sending', command: input });
    try {
      const saved = await api.save(input, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
      void changes.policy(source.id);
      if (controller.signal.aborted || !mounted.current) return;
      if (!latestRule.current || saved.revision > latestRule.current.revision) latestRule.current = saved;
      setDraft({ base: saved, target: saved.targetFamilyId });
      setSave({ kind: 'saved' });
      recovery.clear();
    } catch (error) {
      if (error instanceof TableRequestError && error.code.startsWith('model-family')) void changes.rejected();
      if (controller.signal.aborted || !mounted.current) return;
      if (error instanceof TableRequestError && (error.status === 401 || error.status === 403 || error.status === 404))
        setDenial({ version: currentAccessVersion.current, status: error.status });
      if (recovering && error instanceof TableRequestError && [401, 403, 404].includes(error.status))
        setSave({ kind: 'uncertain', command: input });
      else if (error instanceof TableRequestError && error.code === 'model-policy-revision-conflict') {
        recovery.clear();
        setSave({ kind: 'conflict' });
      } else if (
        error instanceof TableRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status) &&
        error.code !== 'idempotency-conflict'
      ) {
        recovery.clear();
        setSave({ kind: 'rejected', message: error.message });
      } else setSave({ kind: 'uncertain', command: input });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  const uncertain = save.kind === 'uncertain' || save.kind === 'sending';
  const changedElsewhere =
    draft !== null && read.state.kind === 'ready' && read.state.data.revision > draft.base.revision;
  const conflict = save.kind === 'conflict' || changedElsewhere;
  const blocked =
    uncertain || conflict || !writable || read.state.kind !== 'ready' || read.state.refreshing || !!read.state.error;
  const eligibleTarget = (target: string | null) =>
    target === null ||
    (source.available &&
      families.some(family => family.id === target && family.available && family.fallbackFor.includes(source.id)));
  const visibleRead =
    read.state.kind === 'ready' && draft && draft.base.revision > read.state.data.revision
      ? { ...read.state, data: draft.base }
      : read.state;
  const savedTarget = visibleRead.kind === 'ready' ? visibleRead.data.targetFamilyId : undefined;
  const targetName = (id: string) => families.find(family => family.id === id)?.displayName ?? id;
  const dirty = !uncertain && draft !== null && draft.target !== draft.base.targetFamilyId;
  const savedUnavailable =
    !!savedTarget &&
    families.some(family => family.id === savedTarget) &&
    !families.some(family => family.id === savedTarget && family.available && family.fallbackFor.includes(source.id));
  const trySave = (target: string | null) => {
    if (active.current || blocked || !draft || !eligibleTarget(target) || target === draft.base.targetFamilyId) return;
    void submit({
      requestId: crypto.randomUUID(),
      sourceFamilyId: source.id,
      targetFamilyId: target,
      expectedRevision: draft.base.revision,
    });
  };
  const status =
    save.kind === 'sending'
      ? 'Saving…'
      : admin && save.kind === 'saved'
        ? 'Saved'
        : savedUnavailable
          ? `${targetName(savedTarget)} is unavailable. Kept until an admin changes it.`
          : undefined;
  const ready = read.state.kind === 'ready' && !denial;
  const fallback = (
    <>
      {ready &&
        (admin && draft ? (
          <>
            <Select
              value={draft.target && families.some(family => family.id === draft.target) ? draft.target : ''}
              disabled={uncertain || !writable}
              onValueChange={value => {
                const target = value || null;
                setDraft({ ...draft, target });
                if (!conflict) setSave({ kind: 'idle' });
                trySave(target);
              }}
            >
              <SelectTrigger
                width="full"
                id={`fallback-${source.id}`}
                aria-label={`Fallback for ${source.displayName}`}
                aria-busy={save.kind === 'sending'}
              >
                <SelectValue>
                  {draft.target && families.some(family => family.id === draft.target)
                    ? targetName(draft.target)
                    : 'No fallback'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">No fallback</SelectItem>
                {families
                  .filter(family => family.id !== source.id)
                  .map(family => (
                    <SelectItem key={family.id} value={family.id} disabled={!eligibleTarget(family.id)}>
                      {family.displayName}
                      {eligibleTarget(family.id) ? '' : ' (unavailable)'}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {dirty && !conflict && (
              <Button
                size="sm"
                disabled={blocked || !eligibleTarget(draft.target)}
                onClick={() => trySave(draft.target)}
              >
                Save
              </Button>
            )}
          </>
        ) : (
          <span>
            {savedTarget && families.some(family => family.id === savedTarget)
              ? targetName(savedTarget)
              : 'No fallback'}
          </span>
        ))}
      {status && (
        <span role="status" className="basis-full text-xs text-muted-foreground">
          {status}
        </span>
      )}
      {read.state.kind === 'ready' && read.state.refreshing && (
        <span role="status" className="sr-only">
          Refreshing fallback rule…
        </span>
      )}
    </>
  );
  const below = (
    <>
      {denial ? (
        <div>
          <ModelRead
            state={{ kind: 'unavailable', status: denial.status }}
            refresh={refreshAccess}
            label="fallback rule"
          >
            {() => null}
          </ModelRead>
        </div>
      ) : read.state.kind !== 'ready' ? (
        <div>
          <ModelRead
            state={read.state}
            refresh={read.state.kind === 'unavailable' ? refreshAccess : read.refresh}
            label="fallback rule"
          >
            {() => null}
          </ModelRead>
        </div>
      ) : (
        read.state.error && (
          <div>
            <ModelRead state={visibleRead} refresh={read.refresh} label="fallback rule">
              {() => null}
            </ModelRead>
          </div>
        )
      )}
      {admin && (save.kind === 'rejected' || conflict || command) && (
        <div className="space-y-3">
          {save.kind === 'rejected' && (
            <Alert variant="destructive">
              <AlertDescription>{save.message}</AlertDescription>
            </Alert>
          )}
          {conflict && (
            <>
              <Alert variant="destructive">
                <AlertDescription>
                  Another admin changed this rule. Reload the latest rule to review it alongside your retained choice,
                  then save again. Reloading does not save your choice.
                </AlertDescription>
              </Alert>
              <Button
                variant="outline"
                disabled={uncertain || !writable || (read.state.kind === 'ready' && read.state.refreshing)}
                onClick={() => {
                  rebase.current = true;
                  void read.refresh();
                }}
              >
                Reload latest rule
              </Button>
            </>
          )}
          {command && (
            <>
              <Alert>
                <AlertDescription>
                  We could not confirm the fallback change for {source.displayName}. Your submitted choice survives
                  navigation and reload in this tab until the tab closes. Check save status before retrying.
                </AlertDescription>
              </Alert>
              <ModelRead state={receipt.state} refresh={receipt.refresh} label="save status">
                {status =>
                  status.kind === 'missing' ? (
                    <p>
                      No saved result is visible. This can also mean access changed. Retrying repeats only the original
                      change.
                    </p>
                  ) : (
                    <p role="status">Save confirmed.</p>
                  )
                }
              </ModelRead>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={
                    !writable ||
                    receipt.state.kind === 'loading' ||
                    (receipt.state.kind === 'ready' && receipt.state.refreshing)
                  }
                  onClick={() => void receipt.refresh()}
                >
                  Check save status
                </Button>
                {receipt.state.kind === 'ready' && receipt.state.data.kind === 'missing' && !receipt.state.error && (
                  <Button
                    variant="outline"
                    disabled={!canReconcile || receipt.state.refreshing}
                    onClick={() => void submit(command)}
                  >
                    Retry same save
                  </Button>
                )}
                <Button variant="ghost" nativeButton={false} render={<Link to="/account/workspace-recovery" />}>
                  Recover workspace changes
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
  const hasBelow =
    !!denial ||
    read.state.kind !== 'ready' ||
    !!read.state.error ||
    (admin && (save.kind === 'rejected' || conflict || !!command));
  return (
    <>
      <UnsavedChanges dirty={dirty} />
      {concealed ? null : <AccessRow parts={row} fallback={fallback} below={hasBelow && below} />}
    </>
  );
}
