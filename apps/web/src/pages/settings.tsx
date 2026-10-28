import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { workspaceRoute } from '@/router';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@tulipfarm/sprout/dialog';
import { Badge } from '@tulipfarm/sprout/badge';
import { ModelRead } from '@/features/models/read';
import { useWorkspaceSettings, useSettingsChanges } from '@/features/settings/queries';
import { useGovernanceChanges } from '@/features/governance/changes';
import { UnsavedChanges } from '@/features/tables/feedback';
import { settingsApi, settingsCommandSchema, type Settings } from '@/features/settings/api';
import { commandRecovery } from '@/features/settings/command-recovery';
import { useSettingsCommand } from '@/features/settings/use-settings-command';
import { useSettingsReceipt } from '@/features/settings/receipt-queries';
import { CommandFeedback } from '@/features/settings/command-feedback';
import { changeGovernance, governanceError, GovernanceRequestError } from '@/lib/governance';
import { forgetWorkspace } from '@/lib/last-workspace';
import { TeamConfirmation } from './team-administration';
import { AvatarImagePicker } from '@/features/avatar/image-picker';
import { EntityAvatar } from '@tulipfarm/sprout/avatar';
import { useFlag } from '@/lib/feature-flags';
import { KnowledgeSettings } from '@/features/files/knowledge-settings';

export function SettingsPage() {
  const { workspace, user, membershipId } = workspaceRoute.useRouteContext();
  return (
    <GeneralSettings
      key={`${user.id}:${workspace.id}:${membershipId}`}
      workspaceId={workspace.id}
      slug={workspace.slug}
      userId={user.id}
    />
  );
}

function GeneralSettings({ workspaceId, slug, userId }: { workspaceId: string; slug: string; userId: string }) {
  const soulExplorer = useFlag('soul-repository-explorer');
  const router = useRouter();
  const api = useMemo(() => settingsApi(workspaceId), [workspaceId]);
  const receipt = useSettingsReceipt(workspaceId);
  const recovery = useMemo(
    () => commandRecovery({ userId, workspaceId, channel: 'settings', schema: settingsCommandSchema }),
    [userId, workspaceId],
  );
  const [restored] = useState(() => recovery.load());
  const [draft, setDraft] = useState<{ base: Settings; name: string } | null>(null);
  const changes = useSettingsChanges();
  const governanceChanges = useGovernanceChanges();
  const [denied, setDenied] = useState(false);
  const [exit, setExit] = useState(false);
  const [leave, setLeave] = useState<{ kind: 'idle' } | { kind: 'sending' } | { kind: 'error'; message: string }>({
    kind: 'idle',
  });
  const leaving = useRef(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const read = useWorkspaceSettings(workspaceId);
  const settings = read.state.kind === 'ready' ? read.state.data.settings : null;
  useEffect(() => {
    if (!settings) return;
    setDenied(false);
    setDraft(
      previous =>
        previous ??
        (restored?.kind === 'rename'
          ? { base: { ...settings, revision: restored.expectedRevision }, name: restored.name }
          : { base: settings, name: settings.name }),
    );
  }, [settings, restored]);
  const saved = async (result: Awaited<ReturnType<typeof api.save>>) => {
    if ('status' in result) changes.removed(workspaceId);
    else await changes.saved();
    return result;
  };
  const command = useSettingsCommand({
    send: async (input, signal) => saved(await api.save(input, signal)),
    receipt: async (input, signal) => saved(await receipt(input, signal)),
    recovery,
    onSaved: result => {
      if ('status' in result) {
        setDeleteOpen(false);
        setExit(true);
        return;
      }
      setDraft(previous => {
        if (!previous) return previous;
        if ('icon' in result)
          return { base: { ...previous.base, icon: result.icon, revision: result.revision }, name: previous.name };
        const base = { ...previous.base, name: result.name, revision: result.revision };
        return { base, name: result.name };
      });
      void router.invalidate();
    },
    onDenied: () => {
      setDenied(true);
      setDeleteOpen(false);
      void governanceChanges.accessLost();
    },
  });
  useEffect(() => {
    if (!exit) return;
    forgetWorkspace(userId);
    void router.navigate({ to: '/', replace: true });
  }, [exit, userId, router]);
  const current = read.state.kind === 'ready' ? read.state.data : null;
  const admin = !!current?.settings.canManage && current.membership.role === 'admin' && !denied;
  const stale = read.state.kind !== 'ready' || read.state.refreshing || !!read.state.error;
  const conflict =
    command.state.kind === 'conflict' || (!!draft && !!current && current.settings.revision > draft.base.revision);
  const dirty = !!draft && draft.name !== draft.base.name;
  const blocked = stale || command.unresolved || leave.kind === 'sending' || exit;
  const validName = !!draft?.name.trim() && draft.name.trim().length <= 80;
  useEffect(() => {
    if (!admin) setDeleteOpen(false);
  }, [admin]);
  const nameSaved =
    command.state.kind === 'saved' && !('status' in command.state.receipt) && !('icon' in command.state.receipt);
  const iconSaved = command.state.kind === 'saved' && 'icon' in command.state.receipt;
  return (
    <PageContent>
      <UnsavedChanges dirty={!exit && dirty && !command.unresolved} />
      <PageHeader
        titleId="governance-heading"
        focusable
        title="General"
        description="Manage your workspace identity and membership."
      />
      <ModelRead state={read.state} refresh={read.refresh} label="workspace settings">
        {({ settings, membership }) => (
          <>
            <SettingsGroup title="Workspace identity" titleId="identity-heading">
              {!admin && (
                <p className="px-4 py-3 text-sm text-muted-foreground">
                  Only workspace admins can rename or close this workspace.
                </p>
              )}
              {!admin && (
                <SettingsRow label="Workspace icon">
                  <EntityAvatar
                    seed={settings.workspaceId}
                    name={settings.name}
                    image={settings.icon}
                    size="lg"
                    shape="square"
                  />
                </SettingsRow>
              )}
              {admin && draft && (
                <SettingsRow
                  label="Workspace icon"
                  description="Shown in the sidebar and workspace menu. PNG, JPEG, or WebP, up to 2 MB. It is resized to 128 px. Without one, a colored initial is shown."
                >
                  <AvatarImagePicker
                    seed={settings.workspaceId}
                    name={settings.name}
                    image={draft.base.icon}
                    shape="square"
                    disabled={blocked || conflict}
                    onChange={icon =>
                      void command.submit({
                        kind: 'icon',
                        requestId: crypto.randomUUID(),
                        expectedRevision: draft.base.revision,
                        icon,
                      })
                    }
                  />
                </SettingsRow>
              )}
              {command.state.kind === 'sending' && command.state.command.kind === 'icon' && (
                <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
                  Saving icon…
                </p>
              )}
              {iconSaved && (
                <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
                  Workspace icon saved.
                </p>
              )}
              {!admin && (
                <SettingsRow label="Workspace name">
                  <p className="break-words text-sm">{settings.name}</p>
                </SettingsRow>
              )}
              {admin && draft && (
                <form
                  onSubmit={event => {
                    event.preventDefault();
                    if (!admin || blocked || conflict || !validName || !dirty) return;
                    void command.submit({
                      kind: 'rename',
                      requestId: crypto.randomUUID(),
                      expectedRevision: draft.base.revision,
                      name: draft.name.trim(),
                    });
                  }}
                >
                  <SettingsRow
                    label="Workspace name"
                    htmlFor="workspace-name"
                    description={
                      <span id="workspace-name-help">
                        {validName
                          ? 'Use a name of up to 80 characters. Renaming does not change the workspace URL.'
                          : 'Enter a name of 1 to 80 characters.'}
                      </span>
                    }
                  >
                    <div className="w-full sm:w-64">
                      <Input
                        id="workspace-name"
                        value={draft.name}
                        maxLength={80}
                        required
                        readOnly={command.unresolved}
                        aria-invalid={!validName}
                        aria-describedby="workspace-name-help"
                        onChange={event => {
                          setDraft({ ...draft, name: event.target.value });
                          if (!conflict) command.reset();
                        }}
                      />
                    </div>
                  </SettingsRow>
                  {admin && (dirty || nameSaved) && (
                    <div className="flex flex-wrap items-center justify-end gap-2 px-4 pb-3">
                      {nameSaved && (
                        <p role="status" className="mr-auto text-sm text-muted-foreground">
                          Workspace name saved.
                        </p>
                      )}
                      {dirty && (
                        <p className="mr-auto break-words text-sm text-muted-foreground">
                          Current saved name: {settings.name}
                        </p>
                      )}
                      <Button
                        type="submit"
                        disabled={blocked || conflict || !validName || !dirty}
                        aria-busy={command.state.kind === 'sending'}
                      >
                        {command.state.kind === 'sending' && command.state.command.kind === 'rename'
                          ? 'Saving name…'
                          : 'Save name'}
                      </Button>
                      <Button
                        variant="ghost"
                        type="button"
                        disabled={blocked || !dirty}
                        onClick={() => {
                          setDraft({ base: settings, name: settings.name });
                          command.reset();
                        }}
                      >
                        Reset name
                      </Button>
                    </div>
                  )}
                </form>
              )}
              {conflict && admin && (
                <div className="space-y-3 px-4 py-3">
                  <Alert variant="destructive">
                    <AlertDescription>
                      Workspace settings changed. Your draft is retained. Reload the latest settings, review the saved
                      name, then save deliberately.
                    </AlertDescription>
                  </Alert>
                  <Button
                    variant="outline"
                    disabled={blocked}
                    onClick={async () => {
                      const latest = await read.reloadSettings();
                      if (latest) {
                        setDraft(previous => previous && { ...previous, base: latest });
                        command.reset();
                      }
                    }}
                  >
                    Reload latest settings
                  </Button>
                </div>
              )}
              <SettingsRow label="Workspace URL" description="Permanent address. This cannot be edited.">
                <code className="break-all text-sm select-all">{`${window.location.origin}/${settings.slug}`}</code>
              </SettingsRow>
              <SettingsRow label="Workspace ID" description="Use this identifier when contacting support.">
                <code className="break-all text-sm select-all">{settings.workspaceId}</code>
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Your membership" titleId="membership-heading">
              <SettingsRow label="Role" description="Your role in this workspace.">
                <Badge variant="secondary">{membership.role}</Badge>
              </SettingsRow>
              <SettingsRow
                label="Leave workspace"
                description={
                  membership.capabilities.canLeave
                    ? 'Leaving removes your membership and team access. Your account and other workspaces remain available.'
                    : 'You are the last admin. Invite a member and promote them to admin before leaving.'
                }
              >
                <TeamConfirmation
                  label="Leave workspace"
                  title="Leave this workspace?"
                  description="You will lose workspace access and all team memberships. Only an admin can invite you back. Your account and other workspaces remain available."
                  busy={blocked || !membership.capabilities.canLeave || dirty}
                  run={async () => {
                    if (leaving.current) return 'rejected';
                    leaving.current = true;
                    setLeave({ kind: 'sending' });
                    try {
                      await changeGovernance(workspaceId, '/leave', 'POST');
                      changes.removed(workspaceId);
                      setExit(true);
                      return 'saved';
                    } catch (error) {
                      setLeave({ kind: 'error', message: governanceError(error) });
                      await read.refresh();
                      return error instanceof GovernanceRequestError && error.status < 500 ? 'rejected' : 'uncertain';
                    } finally {
                      leaving.current = false;
                    }
                  }}
                />
              </SettingsRow>
              {leave.kind === 'error' && (
                <div className="px-4 py-3">
                  <Alert variant="destructive">
                    <AlertDescription>{leave.message}</AlertDescription>
                  </Alert>
                </div>
              )}
              <SettingsRow label="Members" description="Invite people and manage roles.">
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={<Link to="/$workspaceSlug/members" params={{ workspaceSlug: slug }} />}
                >
                  Manage members
                </Button>
              </SettingsRow>
            </SettingsGroup>
            {admin && soulExplorer && (
              <SettingsGroup title="Soul repository" titleId="soul-heading">
                <SettingsRow
                  label="Saved files"
                  description="Browse the current saved Soul files. Read-only; existing content access rules still apply."
                >
                  <Button
                    variant="outline"
                    nativeButton={false}
                    render={<Link to="/$workspaceSlug/settings/soul" params={{ workspaceSlug: slug }} />}
                  >
                    Open Soul
                  </Button>
                </SettingsRow>
              </SettingsGroup>
            )}
            {admin && <KnowledgeSettings workspaceId={workspaceId} />}
            {admin && (
              <SettingsGroup title="Close workspace" titleId="delete-heading">
                <SettingsRow
                  label="Close this workspace"
                  description="Access ends for everyone. Rows, files, and backups stay stored. Closing does not erase them."
                >
                  <Button
                    variant="destructive"
                    disabled={blocked || dirty || conflict}
                    onClick={() => {
                      setConfirmation('');
                      setAcknowledged(false);
                      setDeleteOpen(true);
                    }}
                  >
                    Close workspace
                  </Button>
                </SettingsRow>
              </SettingsGroup>
            )}
          </>
        )}
      </ModelRead>
      {command.state.kind === 'sending' && command.state.command.kind === 'delete' && (
        <p role="status">Closing workspace…</p>
      )}
      <CommandFeedback
        state={command.state}
        check={command.check}
        retry={input => void command.submit(input)}
        writable={admin && !stale}
      />
      <Dialog
        open={deleteOpen}
        onOpenChange={open => {
          if (!command.busy) setDeleteOpen(open);
        }}
      >
        <DialogContent size="form" finalFocus={() => document.getElementById('delete-heading')}>
          <DialogHeader>
            <DialogTitle>Close this workspace for everyone?</DialogTitle>
            <DialogDescription>
              Everyone loses access to this workspace. Closing does not erase stored data.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 overflow-y-auto">
            <ul className="list-disc space-y-2 pl-5 text-base">
              <li>Rows, files, and backups are retained.</li>
              <li>Your account and other workspaces remain available.</li>
              <li>Restoration and an erasure deadline are not promised.</li>
            </ul>
            <form
              className="space-y-4"
              onSubmit={event => {
                event.preventDefault();
                if (!current || !admin || blocked || confirmation !== current.settings.name || !acknowledged) return;
                void command.submit({
                  kind: 'delete',
                  requestId: crypto.randomUUID(),
                  expectedRevision: current.settings.revision,
                  confirmationName: confirmation,
                  acknowledgeRetainedData: true,
                });
                setDeleteOpen(false);
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="delete-confirmation">Type the exact workspace name</Label>
                <p className="break-words text-sm text-muted-foreground">{current?.settings.name}</p>
                <Input
                  id="delete-confirmation"
                  autoComplete="off"
                  value={confirmation}
                  onChange={event => setConfirmation(event.target.value)}
                />
              </div>
              <div className="flex items-start gap-3">
                <Checkbox id="retained-data" checked={acknowledged} onCheckedChange={setAcknowledged} />
                <Label htmlFor="retained-data">I understand that workspace data is retained, not erased.</Label>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" type="button" onClick={() => setDeleteOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  type="submit"
                  disabled={blocked || !admin || !acknowledged || confirmation !== current?.settings.name}
                >
                  Close workspace for everyone
                </Button>
              </div>
            </form>
          </div>
        </DialogContent>
      </Dialog>
    </PageContent>
  );
}
