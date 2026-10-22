import { useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import type { ActionState } from '@/components/action-button';
import { ChoiceGroup } from '@tulipfarm/sprout/field';
import { Form, FormFooter, FormSection } from '@tulipfarm/sprout/form';
import { UnsavedChanges } from '@/features/tables/feedback';
import { useMcpPermissions } from './queries';
import type { McpApi } from './api';
import type { AgentPermissions, PermissionSlot } from './contracts';
import { McpCommandFeedback, McpGate, McpRead, useMcpCommand } from './state';

type Tool = PermissionSlot['tools'][number];
const toolKey = (tool: Tool) => JSON.stringify([tool.name, tool.revision]);

export function McpAgentPermissions({
  workspaceId,
  agentId,
  saveBlockedReason,
  changed,
}: {
  workspaceId: string;
  agentId: string;
  saveBlockedReason?: string | undefined;
  changed: () => Promise<void>;
}) {
  return (
    <McpGate workspaceId={workspaceId}>
      {api => <Permissions api={api} agentId={agentId} saveBlockedReason={saveBlockedReason} changed={changed} />}
    </McpGate>
  );
}
function Permissions({
  api,
  agentId,
  saveBlockedReason,
  changed,
}: {
  api: McpApi;
  agentId: string;
  saveBlockedReason: string | undefined;
  changed: () => Promise<void>;
}) {
  const read = useMcpPermissions(api, agentId);
  const stale =
    read.state.kind !== 'ready'
      ? undefined
      : read.state.error
        ? 'Check the allowlist again before saving.'
        : read.state.refreshing
          ? 'Wait for the allowlist to refresh.'
          : undefined;
  return (
    <FormSection title="MCP tools" label="Agent MCP allowlist" description="Reviewed MCP tools this agent may call.">
      <McpRead state={read.state} refresh={read.refresh} label="Agent MCP permissions">
        {data => (
          <PermissionEditor
            api={api}
            agentId={agentId}
            data={data}
            saveBlockedReason={saveBlockedReason}
            stale={stale}
            refresh={async () => {
              await read.refresh();
              await changed();
            }}
          />
        )}
      </McpRead>
    </FormSection>
  );
}
function PermissionEditor({
  api,
  agentId,
  data,
  saveBlockedReason,
  stale,
  refresh,
}: {
  api: McpApi;
  agentId: string;
  data: AgentPermissions;
  saveBlockedReason: string | undefined;
  stale: string | undefined;
  refresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<{ revision: string; slots: PermissionSlot[] } | null>(null);
  const command = useMcpCommand();
  const slots = draft?.slots ?? data.slots;
  const conflict = !!draft && draft.revision !== data.savedRevision;
  const reason =
    saveBlockedReason ??
    (!data.canEdit
      ? 'You need edit access to change this allowlist.'
      : conflict
        ? 'Choose which allowlist to keep below.'
        : command.blocked
          ? 'Check the last save first.'
          : undefined);
  const save: ActionState = command.busy
    ? { kind: 'busy' }
    : reason
      ? { kind: 'blocked', reason }
      : !draft
        ? { kind: 'blocked', reason: 'No changes to save.' }
        : stale
          ? { kind: 'blocked', reason: stale }
          : { kind: 'ready' };
  const choices = [
    ...data.choices,
    ...data.slots.filter(slot => !data.choices.some(choice => choice.slotId === slot.slotId)),
  ];
  const toggle = (choice: PermissionSlot, tool: Tool, checked: boolean) => {
    const current = slots.find(slot => slot.slotId === choice.slotId);
    const tools = (current?.tools ?? []).filter(item => item.name !== tool.name);
    if (checked) tools.push(tool);
    const next = slots.filter(slot => slot.slotId !== choice.slotId);
    if (tools.length) next.push({ ...choice, tools });
    setDraft({ revision: draft?.revision ?? data.savedRevision, slots: next });
  };
  return (
    <div className="grid gap-5">
      <UnsavedChanges dirty={!!draft || command.busy} />
      <dl className="grid gap-2 text-sm wrap-anywhere">
        <div>
          <dt className="text-muted-foreground">Saved version</dt>
          <dd>{data.savedRevision}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Active version</dt>
          <dd>{data.activeRevision ?? 'Not active'}</dd>
        </div>
      </dl>
      {!choices.length ? (
        <p className="text-sm text-muted-foreground">
          No approved server descriptors are available. Review an account-independent descriptor in Integrations first.
          Unsafe private descriptors stay chat-only.
        </p>
      ) : (
        <Form
          disabled={command.busy || !!reason || !!stale}
          onSubmit={() => {
            if (save.kind === 'ready')
              void command.run(
                () =>
                  api.savePermissions(agentId, {
                    requestId: crypto.randomUUID(),
                    expectedSavedRevision: data.savedRevision,
                    slots,
                  }),
                async () => {
                  setDraft(null);
                  await refresh();
                },
              );
          }}
        >
          <div className="grid gap-5">
            {choices.map(choice => {
              const current = slots.find(slot => slot.slotId === choice.slotId);
              const value = choice.tools
                .filter(tool => current?.tools.some(item => item.name === tool.name && item.revision === tool.revision))
                .map(toolKey);
              return (
                <div key={choice.slotId} className="min-w-0 wrap-anywhere">
                  <ChoiceGroup
                    type="checkbox"
                    optional
                    legend={choice.label}
                    helper={`Reviewed identity ${choice.serverIdentity} · ${choice.binding.kind === 'personal' ? 'Requester binds a personal account privately' : 'Explicit shared integration'}`}
                    options={choice.tools.map(tool => ({
                      value: toolKey(tool),
                      label: `${tool.name} · ${tool.revision}`,
                    }))}
                    value={value}
                    onValueChange={next => {
                      const tool = choice.tools.find(
                        item => next.includes(toolKey(item)) !== value.includes(toolKey(item)),
                      );
                      if (tool) toggle(choice, tool, next.includes(toolKey(tool)));
                    }}
                  />
                </div>
              );
            })}
            <FormFooter
              dirty={!!draft}
              submit={{ label: 'Save MCP allowlist', pendingLabel: 'Saving MCP allowlist…', state: save }}
              cancel={{ kind: 'reset', label: 'Discard changes', onReset: () => setDraft(null) }}
              note="Runs use these tools after a manager activates the new version."
            >
              {conflict && (
                <Alert>
                  <AlertDescription>
                    A newer definition was saved. Your MCP edits are retained. Check current permissions, then choose
                    which revision to edit.
                  </AlertDescription>
                </Alert>
              )}
              {conflict && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setDraft(null)}>
                    Use current MCP allowlist
                  </Button>
                  <Button variant="outline" onClick={() => setDraft({ revision: data.savedRevision, slots })}>
                    Keep MCP edits against current revision
                  </Button>
                </div>
              )}
              <McpCommandFeedback
                command={command}
                check={async () => {
                  await refresh();
                  command.reset();
                }}
              />
            </FormFooter>
          </div>
        </Form>
      )}
    </div>
  );
}
