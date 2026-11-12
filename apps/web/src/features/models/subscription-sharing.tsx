import { useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Switch } from '@tulipfarm/sprout/switch';
import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { useFeatureChanges, useFeatureRead, useFeatureScope } from '@/lib/query';
import { useOwnMembership } from '@/features/governance/queries';
import type { SecretGrant } from '@/features/secrets/contracts';
import { GrantsEditor, granteeKey, type People, type RoleOptions } from '@/features/secrets/grants-editor';
import { useMemberDirectory } from '@/features/secrets/queries';
import { TableRequestError } from '@/features/tables/request-state';
import { planModelVendor } from './model-brand';
import { ModelLogo } from './model-logo';
import { modelKeys } from './queries';

export const subscriptionsKey = ['models', 'subscriptions'] as const;

export const providerLabels = { chatgpt: 'ChatGPT', claude: 'Claude', copilot: 'GitHub Copilot' } as const;

const grantSchema = z.object({
  grantee: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('member'), membershipId: z.uuid() }),
    z.object({ kind: z.literal('team'), teamId: z.uuid() }),
    z.object({ kind: z.literal('workspace') }),
  ]),
  role: z.enum(['use', 'manage']),
});
const subscriptionSchema = z.object({
  connectionId: z.uuid(),
  provider: z.enum(['chatgpt', 'claude', 'copilot']),
  ownerMembershipId: z.uuid(),
  account: z.string().nullable(),
  state: z.enum(['connected', 'plan-disabled', 'reconnect-required', 'signed-out']),
  mine: z.boolean(),
  models: z.array(z.object({ slug: z.string(), label: z.string() })),
  disabledModels: z.array(z.string()),
  canShare: z.boolean(),
  grants: z.array(grantSchema).nullable(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

const errors: Record<string, string> = {
  'subscription-not-found': 'This plan is no longer connected. Reload to see the current plans.',
  'subscription-not-connected': 'This plan needs sign-in again before you can change it.',
  'subscription-invalid-grant':
    'This plan can’t be shared with one of the people or teams you chose. Check that they’re still in this workspace, then try again.',
  'subscription-access-denied': 'You can’t change who uses this plan. Ask its owner to change who it’s shared with.',
  'subscription-invalid-model': 'This plan no longer lists that model. Reload to see its current models.',
};
const errorMessage = (code: string) => errors[code] ?? 'Sharing couldn’t be saved. Try again.';
const modelsErrorMessage = (code: string) =>
  code === 'subscription-access-denied'
    ? 'Only the plan’s owner can turn its models on or off.'
    : (errors[code] ?? 'The change couldn’t be saved. Try again.');

function subscriptionsApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/subscriptions`;
  async function request(path: string, signal: AbortSignal, method: 'GET' | 'PUT' = 'GET', body?: unknown) {
    const response = await jsonResponse(`${base}${path}`, { method, cache: 'no-store', signal, body });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'unavailable');
      throw new TableRequestError(response.status, code, errorMessage(code));
    }
    return value;
  }
  return {
    list: async (signal: AbortSignal) =>
      z.object({ subscriptions: z.array(subscriptionSchema) }).parse(await request('', signal)).subscriptions,
    share: async (connectionId: string, grants: SecretGrant[], signal: AbortSignal) => {
      await request(`/${encodeURIComponent(connectionId)}/grants`, signal, 'PUT', { grants });
    },
    setModels: async (connectionId: string, disabledModels: string[], signal: AbortSignal) => {
      await request(`/${encodeURIComponent(connectionId)}/models`, signal, 'PUT', { disabledModels });
    },
  };
}

const planRoles = {
  use: { label: 'Use it', hint: 'Pick its models in chats' },
  manage: { label: 'Use and share it', hint: 'Also change who it’s shared with' },
} as const satisfies RoleOptions;

export function usePeople(workspaceId: string): People {
  const scope = useFeatureScope();
  const you = scope.kind === 'workspace' ? scope.membershipId : '';
  const directory = useMemberDirectory(workspaceId);
  const membership = useOwnMembership(workspaceId);
  const members = directory.state.kind === 'ready' ? directory.state.data : [];
  return {
    you,
    name: id => (id === you ? 'You' : (members.find(member => member.id === id)?.name ?? 'A former member')),
    members: members.map(member => ({ id: member.id, name: member.name })),
    teams: membership.state.kind === 'ready' ? membership.state.data.teams : [],
  };
}

export function useSubscriptions(workspaceId: string) {
  const api = useMemo(() => subscriptionsApi(workspaceId), [workspaceId]);
  return { api, read: useFeatureRead({ key: subscriptionsKey, load: api.list }) };
}

export function audience(grants: readonly SecretGrant[], people: People) {
  if (!grants.length) return 'No one else';
  return grants
    .map(grant =>
      grant.grantee.kind === 'workspace'
        ? 'Everyone in the workspace'
        : grant.grantee.kind === 'team'
          ? (people.teams.find(team => grant.grantee.kind === 'team' && team.id === grant.grantee.teamId)?.name ??
            'Another team')
          : people.name(grant.grantee.membershipId),
    )
    .join(', ');
}

export function ShareDialog({
  workspaceId,
  subscription,
  people,
  close,
}: {
  workspaceId: string;
  subscription: Subscription;
  people: People;
  close: () => void;
}) {
  const { api } = useSubscriptions(workspaceId);
  const { change } = useFeatureChanges();
  const before = subscription.grants ?? [];
  const [grants, setGrants] = useState<SecretGrant[]>(before);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = providerLabels[subscription.provider];
  const firstShare = !before.length && grants.length > 0;
  const unchanged = before.map(granteeKey).join() === grants.map(granteeKey).join();
  async function save() {
    setSending(true);
    setError(null);
    try {
      await api.share(subscription.connectionId, grants, AbortSignal.timeout(30_000));
      await change({ keys: [subscriptionsKey, modelKeys.catalog()] });
      close();
    } catch (failure) {
      setError(failure instanceof TableRequestError ? failure.message : errorMessage('unavailable'));
    } finally {
      setSending(false);
    }
  }
  return (
    <Dialog open onOpenChange={open => !open && close()}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Share this {provider} plan</DialogTitle>
          <DialogDescription>
            People you share with can pick its models in their chats. No one can see its sign-in details.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <GrantsEditor
            value={grants}
            owner={subscription.ownerMembershipId}
            people={people}
            disabled={sending}
            roles={planRoles}
            description="If someone can use more than one plan, TulipFarm tries their own first, then plans shared with them, then with their teams, then with everyone. If none can answer, the workspace’s fallback model does, if one is set."
            onChange={next => {
              setError(null);
              setGrants(next);
            }}
          />
          {firstShare && (
            <Alert>
              <AlertDescription>
                {subscription.account
                  ? `This plan belongs to ${subscription.account}.`
                  : subscription.ownerMembershipId === people.you
                    ? 'This is your plan.'
                    : `This plan belongs to ${people.name(subscription.ownerMembershipId)}.`}{' '}
                {provider} may limit or close accounts that are shared. Everyone you share with draws on this plan’s
                usage limits.
              </AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={sending} onClick={close}>
            Cancel
          </Button>
          <Button disabled={sending || unchanged} aria-busy={sending} onClick={() => void save()}>
            {sending ? 'Saving…' : firstShare ? 'Share anyway' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const planStates: Record<
  Subscription['state'],
  { label: string; variant: 'success' | 'warning' | 'secondary' }
> = {
  connected: { label: 'Connected', variant: 'success' },
  'reconnect-required': { label: 'Needs sign-in again', variant: 'warning' },
  'plan-disabled': { label: 'Plan usage off', variant: 'secondary' },
  'signed-out': { label: 'Signed out', variant: 'secondary' },
};

/**
 * A plan's models with on/off switches. The owner's choice applies to everyone the plan is shared with; others see the
 * switches read-only.
 */
export function PlanModels({
  workspaceId,
  subscription,
  people,
}: {
  workspaceId: string;
  subscription: Subscription;
  people: People;
}) {
  const { api } = useSubscriptions(workspaceId);
  const { change } = useFeatureChanges();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editable = subscription.mine && subscription.state !== 'signed-out';
  async function toggle(slug: string, on: boolean) {
    const disabled = on
      ? subscription.disabledModels.filter(item => item !== slug)
      : [...subscription.disabledModels, slug];
    setSaving(slug);
    setError(null);
    try {
      await api.setModels(subscription.connectionId, disabled, AbortSignal.timeout(30_000));
      await change({ keys: [subscriptionsKey, modelKeys.catalog()] });
    } catch (failure) {
      setError(
        failure instanceof TableRequestError ? modelsErrorMessage(failure.code) : modelsErrorMessage('unavailable'),
      );
    } finally {
      setSaving(null);
    }
  }
  return (
    <section className="grid gap-2" aria-labelledby={`plan-models-${subscription.connectionId}`}>
      <div>
        <h3 id={`plan-models-${subscription.connectionId}`} className="text-sm font-medium">
          Models
        </h3>
        <p className="text-sm text-muted-foreground">
          {editable
            ? 'No one, including you, can pick a model you turn off.'
            : subscription.mine
              ? 'Reconnect to turn these models on or off.'
              : `Only ${people.name(subscription.ownerMembershipId)} can turn these models on or off.`}
        </p>
      </div>
      {subscription.models.length ? (
        <ul className="divide-y rounded-md border px-3">
          {subscription.models.map(model => {
            const on = !subscription.disabledModels.includes(model.slug);
            return (
              <li key={model.slug} className="flex items-center gap-3 py-2.5 text-sm">
                <ModelLogo vendor={planModelVendor(model.slug)} />
                <span className="flex-1">{model.label}</span>
                <Switch
                  aria-label={model.label}
                  checked={on}
                  disabled={!editable || saving !== null}
                  onCheckedChange={checked => void toggle(model.slug, checked)}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {subscription.state === 'connected'
            ? `${providerLabels[subscription.provider]} lists no models TulipFarm can use with this plan right now.`
            : 'Models appear here once the plan is connected.'}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
