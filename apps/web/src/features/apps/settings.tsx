import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Field, FieldsDisabled } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useConfirmation } from '@/features/access/confirm';
import { useMemberDirectory } from '@/features/secrets/queries';
import { useFeatureScope } from '@/lib/query';
import { workspaceRoute } from '@/router';
import {
  failureMessage,
  granteeKey,
  unitsPerCredit,
  type AppDetail,
  type AppGrant,
  type AppGrantee,
  type AppRole,
} from './api';
import { AppGate, useWorkspaceAdmin } from './app-page';
import { slugError } from './new';
import { useAppApi, useAppChanges, useAppGrants, useNameAvailability } from './queries';
import { approvalLabel, creditsLabel, creditsToUnits, roleLabels, servingStatus } from './labels';

export function AppSettingsPage() {
  return (
    <PageContent>
      <AppGate>{app => <Settings app={app} />}</AppGate>
    </PageContent>
  );
}

/** Runs one change at a time and keeps its failure for the section that started it. */
function useAction() {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return {
    pending,
    failure,
    done,
    run: async (work: () => Promise<unknown>, success?: string) => {
      if (pending) return false;
      setPending(true);
      setFailure(null);
      setDone(null);
      try {
        await work();
        setDone(success ?? null);
        return true;
      } catch (error) {
        setFailure(failureMessage(error));
        return false;
      } finally {
        setPending(false);
      }
    },
  };
}

function Feedback({ action }: { action: ReturnType<typeof useAction> }) {
  if (action.failure)
    return (
      <Alert variant="destructive">
        <AlertDescription>{action.failure}</AlertDescription>
      </Alert>
    );
  if (action.done)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {action.done}
      </p>
    );
  return null;
}

function Settings({ app }: { app: AppDetail }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const admin = useWorkspaceAdmin(workspace.id);
  const editor = app.role === 'edit';
  return (
    <>
      <PageHeader
        titleId="settings-heading"
        focusable
        title="Settings"
        parent={{
          label: app.title,
          link: (
            <Link to="/$workspaceSlug/apps/$appSlug" params={{ workspaceSlug: workspace.slug, appSlug: app.slug }} />
          ),
        }}
      />
      {!editor && !admin ? (
        <StatePanel
          kind="unavailable"
          heading="h2"
          title="Only editors can change this app"
          description="Ask an editor of this app for edit access."
        />
      ) : (
        <div className="space-y-8 pb-20">
          {editor && <Details app={app} />}
          {editor && app.kind === 'public' && <PublicName app={app} />}
          {editor && <Sharing app={app} />}
          {app.kind === 'public' && <Approval app={app} admin={admin} editor={editor} />}
          {app.kind === 'public' && <Availability app={app} admin={admin} editor={editor} />}
        </div>
      )}
    </>
  );
}

function Details({ app }: { app: AppDetail }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  const api = useAppApi(workspace.id);
  const changes = useAppChanges();
  const action = useAction();
  const [title, setTitle] = useState(app.title);
  const [slug, setSlug] = useState(app.slug);
  const titleError = title.trim() ? undefined : 'Enter a name.';
  const addressError = slug.trim() ? slugError(slug.trim()) : 'Enter an address.';
  const changed = title.trim() !== app.title || slug.trim() !== app.slug;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (titleError || addressError || !changed) return;
    const input = {
      ...(title.trim() !== app.title ? { title: title.trim() } : {}),
      ...(slug.trim() !== app.slug ? { slug: slug.trim() } : {}),
    };
    const saved = await action.run(() => api.update(app.id, input), 'Saved.');
    if (!saved) return;
    await changes.app(app.id);
    if (input.slug)
      await navigate({
        to: '/$workspaceSlug/apps/$appSlug/settings',
        params: { workspaceSlug: workspace.slug, appSlug: input.slug },
        replace: true,
      });
  };
  return (
    <SettingsGroup title="Details" titleId="app-details">
      <form className="space-y-4 p-4" noValidate onSubmit={save}>
        <FieldsDisabled value={action.pending}>
          <Field label="Name" required error={titleError}>
            <Input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} />
          </Field>
          <Field
            label="Address in this workspace"
            required
            helper={`/${workspace.slug}/apps/${slug.trim() || app.slug}. Old links stop working when you change it.`}
            error={addressError}
          >
            <Input value={slug} maxLength={48} onChange={event => setSlug(event.target.value.toLowerCase())} />
          </Field>
        </FieldsDisabled>
        <Feedback action={action} />
        <Button type="submit" disabled={!changed || action.pending} aria-busy={action.pending}>
          Save
        </Button>
      </form>
    </SettingsGroup>
  );
}

const nameReasons = {
  'name-taken': 'Another app already uses this name.',
  'name-reserved': 'This name is reserved. Choose another.',
  'name-invalid': 'Use 3 to 63 lowercase letters, digits and single hyphens.',
} as const;

function PublicName({ app }: { app: AppDetail }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useAppApi(workspace.id);
  const changes = useAppChanges();
  const action = useAction();
  const [name, setName] = useState(app.publicName ?? '');
  const [checked, setChecked] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setChecked(name.trim()), 400);
    return () => clearTimeout(timer);
  }, [name]);
  const candidate = name.trim();
  const unchanged = candidate === (app.publicName ?? '');
  const availability = useNameAvailability(
    workspace.id,
    checked,
    checked !== '' && checked === candidate && !unchanged,
  );
  const result = availability.state.kind === 'ready' && checked === candidate ? availability.state.data : null;
  const error = result && !result.available ? nameReasons[result.reason ?? 'name-invalid'] : undefined;
  const helper = unchanged
    ? 'The name in this app’s web address. Changing it moves the app to a new address.'
    : result?.available
      ? 'This name is free.'
      : 'Checking this name…';
  return (
    <SettingsGroup title="Public name" titleId="app-public-name">
      <form
        className="space-y-4 p-4"
        noValidate
        onSubmit={async event => {
          event.preventDefault();
          if (!candidate || unchanged || error) return;
          if (await action.run(() => api.rename(app.id, candidate), 'Name saved.')) await changes.app(app.id);
        }}
      >
        <FieldsDisabled value={action.pending}>
          <Field label="Public name" required helper={helper} error={error}>
            <Input value={name} maxLength={63} onChange={event => setName(event.target.value.toLowerCase())} />
          </Field>
        </FieldsDisabled>
        <Feedback action={action} />
        <Button
          type="submit"
          disabled={!candidate || unchanged || !!error || action.pending}
          aria-busy={action.pending}
        >
          Save name
        </Button>
      </form>
    </SettingsGroup>
  );
}

const everyone: AppGrantee = { kind: 'workspace' };

function Sharing({ app }: { app: AppDetail }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const scope = useFeatureScope();
  const you = scope.kind === 'workspace' ? scope.membershipId : '';
  const api = useAppApi(workspace.id);
  const changes = useAppChanges();
  const read = useAppGrants(workspace.id, app.id, true);
  const directory = useMemberDirectory(workspace.id);
  const members = directory.state.kind === 'ready' ? directory.state.data : [];
  const action = useAction();
  const confirm = useConfirmation();
  const grants = read.state.kind === 'ready' ? read.state.data : [];
  const shared = new Set(grants.map(grant => granteeKey(grant.grantee)));
  const candidates: { key: string; label: string; grantee: AppGrantee }[] = [
    ...(shared.has('workspace') ? [] : [{ key: 'workspace', label: 'Everyone in this workspace', grantee: everyone }]),
    ...members
      .filter(member => !shared.has(`member:${member.id}`))
      .map(member => ({
        key: `member:${member.id}`,
        label: member.id === you ? `${member.name} (you)` : member.name,
        grantee: { kind: 'member', membershipId: member.id } as const,
      })),
  ];
  const [adding, setAdding] = useState('');
  const [role, setRole] = useState<AppRole>('use');
  const target = candidates.find(candidate => candidate.key === adding);
  const addRole: AppRole = target?.grantee.kind === 'workspace' ? 'use' : role;
  const name = (grantee: AppGrantee) => {
    if (grantee.kind === 'workspace') return 'Everyone in this workspace';
    if (grantee.kind === 'team') return 'A team';
    const member = members.find(entry => entry.id === grantee.membershipId);
    if (!member) return 'A former member';
    return grantee.membershipId === you ? `${member.name} (you)` : member.name;
  };
  const roleId = useId();
  const personId = useId();
  const change = (grant: AppGrant, next: AppRole) =>
    action.run(async () => {
      await api.grant(app.id, grant.grantee, next);
      await changes.grants(app.id);
    });
  return (
    <SettingsGroup title="Sharing" titleId="app-sharing">
      {confirm.element}
      {read.state.kind === 'error' && (
        <div className="p-4">
          <Alert variant="destructive">
            <AlertDescription>{read.state.message}</AlertDescription>
          </Alert>
        </div>
      )}
      {read.state.kind === 'loading' && (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          Loading who has access…
        </p>
      )}
      {grants.map(grant => {
        const key = granteeKey(grant.grantee);
        return (
          <SettingsRow key={key} label={name(grant.grantee)}>
            <div className="flex items-center gap-2">
              {grant.grantee.kind === 'workspace' ? (
                <Badge variant="secondary">{roleLabels.use}</Badge>
              ) : (
                <Select
                  value={grant.role}
                  disabled={action.pending}
                  onValueChange={next => {
                    if (next && next !== grant.role) void change(grant, next as AppRole);
                  }}
                >
                  <SelectTrigger aria-label={`Access for ${name(grant.grantee)}`}>
                    <SelectValue>{roleLabels[grant.role]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="use">{roleLabels.use}</SelectItem>
                    <SelectItem value="edit">{roleLabels.edit}</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={action.pending}
                aria-label={`Remove ${name(grant.grantee)}`}
                onClick={() =>
                  confirm.open({
                    title: `Remove ${name(grant.grantee)}?`,
                    description: 'They lose access to this app right away.',
                    action: 'Remove',
                    run: async () => {
                      try {
                        await api.revoke(app.id, grant.grantee);
                        await changes.grants(app.id);
                        return null;
                      } catch (error) {
                        return failureMessage(error);
                      }
                    },
                  })
                }
              >
                Remove
              </Button>
            </div>
          </SettingsRow>
        );
      })}
      <form
        className="flex flex-wrap items-end gap-3 p-4"
        onSubmit={async event => {
          event.preventDefault();
          if (!target) return;
          const added = await action.run(async () => {
            await api.grant(app.id, target.grantee, addRole);
            await changes.grants(app.id);
          });
          if (added) setAdding('');
        }}
      >
        <div className="min-w-56 flex-1 space-y-1">
          <Label htmlFor={personId}>Share with</Label>
          <Select value={adding} disabled={action.pending} onValueChange={next => setAdding(next ?? '')}>
            <SelectTrigger id={personId} width="full">
              <SelectValue>{target?.label ?? 'Choose a person'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {candidates.map(candidate => (
                <SelectItem key={candidate.key} value={candidate.key}>
                  {candidate.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={roleId}>Access</Label>
          <Select
            value={addRole}
            disabled={action.pending || target?.grantee.kind === 'workspace'}
            onValueChange={next => next && setRole(next as AppRole)}
          >
            <SelectTrigger id={roleId}>
              <SelectValue>{roleLabels[addRole]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="use">{roleLabels.use}</SelectItem>
              <SelectItem value="edit">{roleLabels.edit}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" disabled={!target || action.pending} aria-busy={action.pending}>
          Share
        </Button>
        <div className="basis-full">
          <Feedback action={action} />
        </div>
      </form>
    </SettingsGroup>
  );
}

function Approval({ app, admin, editor }: { app: AppDetail; admin: boolean; editor: boolean }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useAppApi(workspace.id);
  const changes = useAppChanges();
  const action = useAction();
  const confirm = useConfirmation();
  const approved = app.approval.state === 'approved';
  const [limit, setLimit] = useState(
    app.approval.state === 'approved' && app.approval.monthlyLimitUnits
      ? (BigInt(app.approval.monthlyLimitUnits) / unitsPerCredit).toString()
      : '',
  );
  const units = limit.trim() ? creditsToUnits(limit) : null;
  const limitError = limit.trim() && units === null ? 'Enter a whole number of credits.' : undefined;
  const status = approvalLabel(app.approval);
  return (
    <SettingsGroup title="Approval" titleId="app-approval">
      {confirm.element}
      <SettingsRow
        label="Status"
        description="A workspace admin approves a public app before it can go live. It then uses workspace credits."
      >
        <span className="flex flex-col items-end gap-1">
          <Badge variant={status.tone}>{status.label}</Badge>
          {app.approval.state === 'approved' && (
            <span className="text-sm text-muted-foreground">
              {app.approval.monthlyLimitUnits
                ? `Up to ${creditsLabel(app.approval.monthlyLimitUnits)}`
                : 'No monthly limit'}
            </span>
          )}
        </span>
      </SettingsRow>
      {editor && !admin && (app.approval.state === 'not-requested' || app.approval.state === 'rejected') && (
        <SettingsRow label="Ask for approval" description="Workspace admins see your request in this app’s settings.">
          <Button
            variant="outline"
            disabled={action.pending}
            aria-busy={action.pending}
            onClick={async () => {
              if (await action.run(() => api.requestApproval(app.id), 'Request sent.')) await changes.app(app.id);
            }}
          >
            Ask for approval
          </Button>
        </SettingsRow>
      )}
      {admin && (
        <form
          className="space-y-4 p-4"
          noValidate
          onSubmit={async event => {
            event.preventDefault();
            if (limitError) return;
            const done = await action.run(
              () => api.decideApproval(app.id, 'approve', units),
              approved ? 'Limit saved.' : 'Approved.',
            );
            if (done) await changes.app(app.id);
          }}
        >
          <FieldsDisabled value={action.pending}>
            <Field
              label="Monthly credit limit"
              optional
              helper="The most this app can use in a month. Leave empty for no limit."
              error={limitError}
            >
              <Input inputMode="numeric" value={limit} onChange={event => setLimit(event.target.value)} />
            </Field>
          </FieldsDisabled>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={action.pending || !!limitError} aria-busy={action.pending}>
              {approved ? 'Save limit' : 'Approve'}
            </Button>
            {app.approval.state !== 'rejected' && (
              <Button
                type="button"
                variant="outline"
                disabled={action.pending}
                onClick={() =>
                  confirm.open({
                    title: 'Reject this app?',
                    description: 'It cannot go live. Its editors can ask again later.',
                    action: 'Reject',
                    run: async () => {
                      try {
                        await api.decideApproval(app.id, 'reject', null);
                        await changes.app(app.id);
                        return null;
                      } catch (error) {
                        return failureMessage(error);
                      }
                    },
                  })
                }
              >
                Reject
              </Button>
            )}
          </div>
          <Feedback action={action} />
        </form>
      )}
      {!admin && (
        <div className="px-4 pb-4 empty:hidden">
          <Feedback action={action} />
        </div>
      )}
    </SettingsGroup>
  );
}

function Availability({ app, admin, editor }: { app: AppDetail; admin: boolean; editor: boolean }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useAppApi(workspace.id);
  const changes = useAppChanges();
  const action = useAction();
  const confirm = useConfirmation();
  const serving = servingStatus(app);
  const stop = (work: () => Promise<unknown>, done: string) => async () => {
    if (await action.run(work, done)) await changes.app(app.id);
  };
  return (
    <SettingsGroup title="Availability" titleId="app-availability">
      {confirm.element}
      {serving && (
        <SettingsRow label="Status">
          <Badge variant={serving.tone}>{serving.label}</Badge>
        </SettingsRow>
      )}
      {editor && !app.stops.disabledAt && (
        <SettingsRow
          label={app.stops.editorPausedAt ? 'Resume' : 'Pause'}
          description={
            app.stops.editorPausedAt
              ? 'Visitors can reach the app again.'
              : 'Visitors see that the app is paused. Nothing is deleted, and it stops using credits.'
          }
        >
          <Button
            variant="outline"
            disabled={action.pending}
            aria-busy={action.pending}
            onClick={
              app.stops.editorPausedAt
                ? stop(() => api.resume(app.id), 'Resumed.')
                : stop(() => api.pause(app.id), 'Paused.')
            }
          >
            {app.stops.editorPausedAt ? 'Resume' : 'Pause'}
          </Button>
        </SettingsRow>
      )}
      {admin && (
        <SettingsRow
          label={app.stops.disabledAt ? 'Turn back on' : 'Turn off'}
          description={
            app.stops.disabledAt
              ? 'Editors can pause, resume and publish again.'
              : 'Only a workspace admin can turn it back on. Editors cannot publish or resume it.'
          }
        >
          <Button
            variant={app.stops.disabledAt ? 'outline' : 'destructive'}
            disabled={action.pending}
            onClick={
              app.stops.disabledAt
                ? stop(() => api.enable(app.id), 'Turned back on.')
                : () =>
                    confirm.open({
                      title: 'Turn off this app?',
                      description: 'Visitors can no longer reach it. Nothing is deleted.',
                      action: 'Turn off',
                      run: async () => {
                        try {
                          await api.disable(app.id);
                          await changes.app(app.id);
                          return null;
                        } catch (error) {
                          return failureMessage(error);
                        }
                      },
                    })
            }
          >
            {app.stops.disabledAt ? 'Turn back on' : 'Turn off'}
          </Button>
        </SettingsRow>
      )}
      <div className="px-4 pb-4 empty:hidden">
        <Feedback action={action} />
      </div>
    </SettingsGroup>
  );
}
