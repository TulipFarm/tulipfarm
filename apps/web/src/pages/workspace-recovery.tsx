import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { modelAvailabilityCommandSchema, modelPolicyCommandSchema } from '@tulipfarm/agents/model-policy-contracts';
import { modelApi } from '@/features/models/api';
import { useWorkspaceList } from '@/features/workspaces/queries';
import { useWorkspaceChanges } from '@/features/workspaces/changes';
import { useFeatureContext } from '@/lib/query/provider';
import { Disclosure } from '@/components/disclosure';
import { workspaceRecoveryRoute } from '@/router';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { availabilityApi } from '@/features/models/availability-api';
import { settingsApi, settingsCommandSchema } from '@/features/settings/api';
import {
  commandRecovery,
  pendingCommands,
  recoveryChanged,
  type PendingCommand,
} from '@/features/settings/command-recovery';
import { useSettingsCommand } from '@/features/settings/use-settings-command';
import { useSettingsReceipt, useAvailabilityReceipt, useFallbackReceipt } from '@/features/settings/receipt-queries';
import { CommandFeedback } from '@/features/settings/command-feedback';

export function RecoveryNotice({ userId }: { userId: string }) {
  const [pending, setPending] = useState(() => pendingCommands(userId).length > 0);
  useEffect(() => {
    const update = () => setPending(pendingCommands(userId).length > 0);
    window.addEventListener(recoveryChanged, update);
    return () => window.removeEventListener(recoveryChanged, update);
  }, [userId]);
  return pending ? (
    <aside
      aria-label="Unconfirmed workspace changes"
      className="flex flex-wrap items-center justify-center gap-3 border-b border-border p-3"
    >
      <p>You have unconfirmed workspace changes in this tab.</p>
      <Button variant="outline" nativeButton={false} render={<Link to="/account/workspace-recovery" />}>
        Recover workspace changes
      </Button>
    </aside>
  ) : null;
}

export function WorkspaceRecoveryPage() {
  const { userId } = workspaceRecoveryRoute.useRouteContext();
  return <RecoveryList key={userId} userId={userId} />;
}

function RecoveryList({ userId }: { userId: string }) {
  const [pending] = useState(() => pendingCommands(userId));
  const read = useWorkspaceList();
  const names = new Map(read.state.kind === 'ready' ? read.state.data.map(item => [item.id, item.name]) : []);
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <h1 className="text-2xl font-medium">Recover workspace changes</h1>
      <p>
        Check whether your changes were saved without submitting them again. Recovery survives navigation and reload for
        this account until this browser tab closes.
      </p>
      {!pending.length && (
        <StatePanel
          kind="empty"
          title="No unconfirmed changes"
          description="This tab has no retained workspace commands for your account."
        />
      )}
      {read.state.kind === 'loading' && <p role="status">Loading workspace names…</p>}
      {(read.state.kind === 'error' || (read.state.kind === 'ready' && read.state.error)) && (
        <StatePanel
          kind="error"
          title="Could not load workspace names"
          description="You can still check retained commands using their workspace references."
        >
          <Button variant="outline" onClick={() => void read.refresh()}>
            Reload workspace names
          </Button>
        </StatePanel>
      )}
      {pending.map(item => (
        <section
          key={`${item.workspaceId}:${item.channel}:${item.channel === 'fallback' ? item.scope : ''}`}
          className="space-y-3 border-t border-border pt-4"
        >
          <h2 className="text-base font-medium">
            {names.get(item.workspaceId) ?? 'Workspace unavailable'} ·{' '}
            {item.channel === 'fallback'
              ? 'Model fallback'
              : item.channel === 'availability'
                ? 'Model access'
                : item.command.kind === 'delete'
                  ? 'Workspace closure'
                  : item.command.kind === 'icon'
                    ? 'Workspace icon'
                    : 'Workspace name'}
          </h2>
          <p className="text-base">
            {item.channel === 'settings'
              ? item.command.kind === 'rename'
                ? `Requested name: ${item.command.name}`
                : item.command.kind === 'icon'
                  ? item.command.icon
                    ? 'Set a new workspace icon'
                    : 'Remove the workspace icon'
                  : `Close ${item.command.confirmationName}`
              : item.channel === 'availability'
                ? `${item.command.enabled ? 'Enable' : 'Disable'} ${item.command.familyId}`
                : `${item.command.sourceFamilyId} fallback: ${item.command.targetFamilyId ?? 'None'}`}
          </p>
          <Disclosure title="Workspace reference">
            <p className="break-all text-sm">{item.workspaceId}</p>
          </Disclosure>
          {item.channel === 'settings' ? (
            <SettingsRecovery pending={item} />
          ) : item.channel === 'availability' ? (
            <AvailabilityRecovery pending={item} />
          ) : (
            <FallbackRecovery pending={item} />
          )}
        </section>
      ))}
      <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
        Back to TulipFarm
      </Button>
    </main>
  );
}

function FallbackRecovery({ pending }: { pending: Extract<PendingCommand, { channel: 'fallback' }> }) {
  const api = modelApi(pending.workspaceId);
  const receipt = useFallbackReceipt(pending.workspaceId);
  const saved = useRecoveredChange(pending.workspaceId);
  const command = useSettingsCommand({
    send: api.save,
    receipt,
    recovery: commandRecovery({ ...pending, schema: modelPolicyCommandSchema }),
    onSaved: () => {
      void saved('models');
    },
    onDenied: () => {},
  });
  return (
    <>
      <CommandFeedback state={command.state} check={command.check} writable={false} />
      {command.state.kind === 'saved' && <p role="status">Model fallback saved.</p>}
    </>
  );
}

function SettingsRecovery({ pending }: { pending: Extract<PendingCommand, { channel: 'settings' }> }) {
  const api = settingsApi(pending.workspaceId);
  const receipt = useSettingsReceipt(pending.workspaceId);
  const saved = useRecoveredChange(pending.workspaceId);
  const changes = useWorkspaceChanges();
  const command = useSettingsCommand({
    send: api.save,
    receipt,
    recovery: commandRecovery({ ...pending, schema: settingsCommandSchema }),
    onSaved: result => {
      if ('status' in result) changes.removed(pending.workspaceId);
      else {
        void saved('settings');
        void changes.changed();
      }
    },
    onDenied: () => {},
  });
  return (
    <>
      <CommandFeedback state={command.state} check={command.check} writable={false} />
      {command.state.kind === 'saved' && (
        <p role="status">
          {'status' in command.state.receipt
            ? 'Workspace closed. Rows, files, and backups are retained.'
            : 'icon' in command.state.receipt
              ? command.state.receipt.icon
                ? 'Workspace icon saved.'
                : 'Workspace icon removed.'
              : 'Workspace name saved.'}
        </p>
      )}
    </>
  );
}

function AvailabilityRecovery({ pending }: { pending: Extract<PendingCommand, { channel: 'availability' }> }) {
  const api = availabilityApi(pending.workspaceId);
  const receipt = useAvailabilityReceipt(pending.workspaceId);
  const saved = useRecoveredChange(pending.workspaceId);
  const command = useSettingsCommand({
    send: api.save,
    receipt,
    recovery: commandRecovery({ ...pending, schema: modelAvailabilityCommandSchema }),
    onSaved: () => {
      void saved('models');
    },
    onDenied: () => {},
  });
  return (
    <>
      <CommandFeedback state={command.state} check={command.check} writable={false} />
      {command.state.kind === 'saved' && <p role="status">Model access saved.</p>}
    </>
  );
}

function useRecoveredChange(workspaceId: string) {
  const { runtime, scope } = useFeatureContext();
  return (family: 'models' | 'settings') => {
    // The receipt is account-owned and carries no current membership identity.
    // Invalidate every membership partition, including ones held only in another tab.
    return runtime.change(
      { kind: 'account', userId: scope.userId },
      { keys: [['workspace', workspaceId], ...(family === 'settings' ? [['workspaces']] : [])] },
    );
  };
}
