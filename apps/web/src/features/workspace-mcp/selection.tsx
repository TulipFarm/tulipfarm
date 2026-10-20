import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { UnsavedChanges } from '@/features/tables/feedback';
import { useMcpSelection, useMcpPrepareChat } from './queries';
import type { McpApi, PrepareMcpChat } from './api';
import type { Capabilities, Selection, SelectionOrigin } from './contracts';
import { McpCommandFeedback, McpGate, McpRead, useMcpCommand } from './state';
import { McpActions } from './actions';

export type SelectionReceipt = { selectionId: string; version: number };
export type McpSelectionState =
  | { kind: 'none' }
  | { kind: 'selected'; receipt: SelectionReceipt }
  | { kind: 'unresolved' };
type OnSelection = ((state: McpSelectionState) => void) | undefined;
const none: McpSelectionState = { kind: 'none' };
const unresolved: McpSelectionState = { kind: 'unresolved' };
export function McpPrivateContext({
  workspaceId,
  origin,
  disabled = false,
  onSelection,
  draft = false,
  prepareChat,
}: {
  workspaceId: string;
  origin: SelectionOrigin;
  disabled?: boolean;
  onSelection?: (state: McpSelectionState) => void;
  draft?: boolean;
  prepareChat?: PrepareMcpChat;
}) {
  return (
    <McpGate workspaceId={workspaceId}>
      {(api, capabilities) => (
        <section aria-label="Private MCP context" className="space-y-4">
          <McpSelection
            api={api}
            capabilities={capabilities}
            origin={origin}
            disabled={disabled}
            onSelection={onSelection}
            prepareChat={prepareChat}
          />
          {!draft && origin.kind !== 'task-draft' && (
            <McpActions api={api} capabilities={capabilities} kind={origin.kind} originId={origin.id} />
          )}
        </section>
      )}
    </McpGate>
  );
}
export function McpChatActions({ workspaceId, chatId }: { workspaceId: string; chatId: string }) {
  return (
    <McpGate workspaceId={workspaceId}>
      {(api, capabilities) => <McpActions api={api} capabilities={capabilities} kind="chat" originId={chatId} />}
    </McpGate>
  );
}
function McpSelection({
  api,
  capabilities,
  origin,
  disabled,
  onSelection,
  prepareChat,
}: {
  api: McpApi;
  capabilities: Capabilities;
  origin: SelectionOrigin;
  disabled: boolean;
  onSelection: OnSelection;
  prepareChat: PrepareMcpChat | undefined;
}) {
  const { kind } = origin;
  const [prepared, setPrepared] = useState(!prepareChat);
  const prepare = useMcpPrepareChat(api, origin, prepareChat);
  const command = useMcpCommand();
  useEffect(() => {
    if (!prepared) void command.run(prepare, () => setPrepared(true));
  }, [prepare, prepared, command.run]);
  const read = useMcpSelection(api, origin, prepared);
  const savedBindings = useRef(false);
  useEffect(() => {
    const state = read.state;
    if (state.kind === 'ready') savedBindings.current = state.data.bindings.length > 0;
    else if (state.kind !== 'loading') onSelection?.(savedBindings.current ? unresolved : none);
  }, [read.state, onSelection]);
  useEffect(() => () => onSelection?.(savedBindings.current ? unresolved : none), [onSelection]);
  if (!prepared)
    return (
      <div className="space-y-2">
        <p role="status">Preparing private MCP context…</p>
        <McpCommandFeedback
          command={command}
          check={async () => {
            await command.run(prepare, () => setPrepared(true));
          }}
        />
      </div>
    );
  return (
    <section aria-label="MCP integration selection" className="space-y-3">
      <h3 className="text-base font-medium">
        MCP integrations for this {kind === 'chat' ? 'personal chat' : 'private task'}
      </h3>
      <p className="text-sm text-muted-foreground">
        Only your explicit selections make tools available. The assistant cannot choose or switch accounts. Selection
        does not approve a call or disclose private input.
      </p>
      <McpRead state={read.state} refresh={read.refresh} label="MCP selections">
        {(data, blocked) => (
          <SelectionEditor
            api={api}
            origin={origin}
            data={data}
            blocked={blocked || disabled || !capabilities.dispatchEnabled}
            refresh={read.refresh}
            onSelection={onSelection}
          />
        )}
      </McpRead>
    </section>
  );
}
function SelectionEditor({
  api,
  origin,
  data,
  blocked,
  refresh,
  onSelection,
}: {
  api: McpApi;
  origin: SelectionOrigin;
  data: Selection;
  blocked: boolean;
  refresh: () => Promise<void>;
  onSelection: OnSelection;
}) {
  const [draft, setDraft] = useState<{ version: number; bindings: Selection['bindings'] } | null>(null);
  const command = useMcpCommand();
  const bindings = draft?.bindings ?? data.bindings;
  const conflict = !!draft && draft.version !== data.version;
  const locked = blocked || command.blocked || conflict;
  useEffect(() => {
    onSelection?.(
      draft || data.stale
        ? unresolved
        : !data.bindings.length
          ? none
          : blocked || command.blocked
            ? unresolved
            : { kind: 'selected', receipt: { selectionId: data.id, version: data.version } },
    );
  }, [draft, data.id, data.version, data.stale, data.bindings.length, blocked, command.blocked, onSelection]);
  const toggle = (integrationId: string, slotId: string | null, checked: boolean) => {
    const filtered = bindings.filter(
      binding =>
        !(binding.integrationId === integrationId && binding.slotId === slotId) &&
        (!checked || slotId === null || binding.slotId !== slotId),
    );
    setDraft({
      version: draft?.version ?? data.version,
      bindings: checked ? [...filtered, { integrationId, slotId }] : filtered,
    });
    onSelection?.(unresolved);
  };
  return (
    <div className="space-y-3">
      <UnsavedChanges dirty={!!draft || command.busy} />
      {data.stale && (
        <Alert>
          <AlertDescription>
            A selected integration, tool revision, or account changed. The old binding cannot run. Review the available
            accounts and save an explicit selection again. No replacement is chosen automatically.
          </AlertDescription>
        </Alert>
      )}
      {!data.choices.length && (
        <p>
          No eligible MCP integrations. Set up and review an integration in Integrations. Named tasks also need an
          active agent allowlist and an approved account-independent server identity.
        </p>
      )}
      {data.choices.map(choice => {
        const selected = bindings.some(
          binding => binding.integrationId === choice.integration.id && binding.slotId === choice.slotId,
        );
        const unavailable =
          !!choice.unavailableReason ||
          !choice.integration.canUse ||
          choice.integration.status !== 'ready' ||
          !!choice.integration.barrier;
        return (
          <div key={`${choice.integration.id}/${choice.slotId}`} className="min-w-0 space-y-1 border-b py-3">
            <Label>
              <Checkbox
                checked={selected}
                disabled={locked || (unavailable && !selected)}
                onCheckedChange={checked => toggle(choice.integration.id, choice.slotId, checked === true)}
              />
              <span className="break-all">
                {choice.integration.name} · {choice.integration.accountLabel ?? 'No verified account label'}
              </span>
            </Label>
            <p className="break-words text-sm text-muted-foreground">
              {choice.integration.ownership === 'personal' ? 'Your private account' : 'Shared workspace account'}
              {choice.slotLabel ? ` · Agent permission ${choice.slotLabel}` : ''}
            </p>
            {unavailable && (
              <p className="text-sm text-warning">
                {choice.unavailableReason ??
                  (choice.integration.barrier
                    ? 'Paused by unknown outcome. Reconcile before use.'
                    : 'Unavailable. Check integration review and current access.')}
              </p>
            )}
          </div>
        );
      })}
      {!bindings.length && (
        <p className="text-sm">
          No integrations selected. This {origin.kind === 'chat' ? 'chat' : 'task'} has no custom MCP tools.
        </p>
      )}
      {origin.kind !== 'chat' && (
        <p className="text-sm text-muted-foreground">
          Your account binding stays private to this task. Task selections can only narrow the active agent's server and
          tool allowlist.
        </p>
      )}
      <Button
        variant="outline"
        disabled={locked || (!draft && !data.stale)}
        aria-busy={command.busy}
        onClick={() =>
          void command.run(
            async () => {
              const saved = await api.saveSelection(origin, {
                requestId: crypto.randomUUID(),
                expectedVersion: data.version,
                bindings,
              });
              onSelection?.(
                saved.bindings.length
                  ? { kind: 'selected', receipt: { selectionId: saved.id, version: saved.version } }
                  : none,
              );
            },
            async () => {
              setDraft(null);
              await refresh();
            },
          )
        }
      >
        Save MCP selection
      </Button>
      {conflict && (
        <Alert>
          <AlertDescription>
            Your selection changed elsewhere. Your edits remain here. Review current selections before replacing them.
            <Button
              variant="outline"
              onClick={() => {
                setDraft(null);
                command.reset();
              }}
            >
              Use current selection
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <McpCommandFeedback
        command={command}
        check={async () => {
          await refresh();
          command.reset();
        }}
      />
    </div>
  );
}
