import { useEffect, useMemo, useState } from 'react';
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
import { Label } from '@tulipfarm/sprout/label';
import { RadioGroup, RadioGroupItem } from '@tulipfarm/sprout/radio-group';
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
  plan: z.string().nullable(),
  useForChat: z.boolean(),
  useForCoding: z.boolean(),
  createdAt: z.string(),
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
    /** Turns the connection's chat or coding use on or off. */
    setUses: async (connectionId: string, uses: { chat?: boolean; coding?: boolean }, signal: AbortSignal) => {
      await request(`/${encodeURIComponent(connectionId)}/uses`, signal, 'PUT', uses);
    },
  };
}

const planRoles = {
  use: { label: 'Can use', hint: 'Pick its models in chat' },
  manage: { label: 'Can use and share', hint: 'Also choose who can use it' },
} as const satisfies RoleOptions;

type Reach = 'private' | 'workspace' | 'specific';

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

export function useSubscriptions(workspaceId: string, enabled = true) {
  const api = useMemo(() => subscriptionsApi(workspaceId), [workspaceId]);
  return { api, read: useFeatureRead({ key: subscriptionsKey, load: api.list, enabled }) };
}

export function audience(grants: readonly SecretGrant[], people: People) {
  if (!grants.length) return 'no one';
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

const askKey = (workspaceId: string, provider: Subscription['provider']) =>
  `tulipfarm:ask-to-share:${workspaceId}:${provider}`;

/** The member's own connections of `provider`, oldest first. */
export function ownPlans(subscriptions: readonly Subscription[] | null, provider: Subscription['provider']) {
  return (subscriptions ?? []).filter(item => item.provider === provider && item.mine && item.state !== 'signed-out');
}

/**
 * Remembers that the member started connecting a plan account, and which accounts were already connected, so the share
 * question opens once a new one connects. Sign-in can leave the page, so the note lives in session storage.
 */
export function expectNewPlan(workspaceId: string, provider: Subscription['provider'], owns: readonly Subscription[]) {
  try {
    sessionStorage.setItem(
      askKey(workspaceId, provider),
      JSON.stringify(owns.filter(item => item.state === 'connected').map(item => item.connectionId)),
    );
  } catch {
    // Without storage the member can still share from the Share button.
  }
}

/**
 * The account to ask about sharing: one the member just connected that is shared with no one. `ready` holds the
 * question back, such as behind a welcome.
 */
export function useAskToShare(
  workspaceId: string,
  provider: Subscription['provider'],
  owns: readonly Subscription[],
  ready = true,
) {
  const [asking, setAsking] = useState<Subscription | null>(null);
  useEffect(() => {
    if (!ready) return;
    const key = askKey(workspaceId, provider);
    let known: unknown;
    try {
      const stored = sessionStorage.getItem(key);
      if (!stored) return;
      known = JSON.parse(stored);
    } catch {
      return;
    }
    const before = new Set(Array.isArray(known) ? known : []);
    const added = owns.find(item => item.state === 'connected' && !before.has(item.connectionId));
    if (!added) return;
    try {
      sessionStorage.removeItem(key);
    } catch {
      return;
    }
    if (added.canShare && !added.grants?.length) setAsking(added);
  }, [workspaceId, provider, owns, ready]);
  return [asking, () => setAsking(null)] as const;
}

export function ShareDialog({
  workspaceId,
  subscription,
  people,
  close,
  asking = false,
}: {
  workspaceId: string;
  subscription: Subscription;
  people: People;
  close: () => void;
  /** Asked right after the plan connects: keeping it private is a choice, not a cancel. */
  asking?: boolean;
}) {
  const { api } = useSubscriptions(workspaceId);
  const { change } = useFeatureChanges();
  const before = subscription.grants ?? [];
  const [reach, setReach] = useState<Reach>(() =>
    !before.length ? 'private' : before.some(grant => grant.grantee.kind === 'workspace') ? 'workspace' : 'specific',
  );
  const [chosen, setChosen] = useState<SecretGrant[]>(() => before.filter(grant => grant.grantee.kind !== 'workspace'));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = providerLabels[subscription.provider];
  // Sharing with everyone keeps the people who may also share it; their "use" grant is implied.
  const grants: SecretGrant[] =
    reach === 'private'
      ? []
      : reach === 'workspace'
        ? [{ grantee: { kind: 'workspace' }, role: 'use' }, ...chosen.filter(grant => grant.role === 'manage')]
        : chosen;
  const signature = (list: SecretGrant[]) =>
    list
      .map(grant => `${granteeKey(grant)}:${grant.role}`)
      .sort()
      .join();
  const unchanged = signature(before) === signature(grants);
  const empty = reach === 'specific' && !chosen.length;
  const nobodyElse =
    !people.teams.length && people.members.every(member => member.id === subscription.ownerMembershipId);
  const owner =
    subscription.ownerMembershipId === people.you ? 'Only you' : `Only ${people.name(subscription.ownerMembershipId)}`;
  async function save() {
    if (unchanged) return close();
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
  const options: { value: Reach; label: string }[] = [
    { value: 'private', label: owner },
    { value: 'workspace', label: 'Everyone in the workspace' },
    { value: 'specific', label: 'Specific people or teams' },
  ];
  return (
    <Dialog open onOpenChange={open => !open && close()}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Who can use this {provider} plan?</DialogTitle>
          <DialogDescription>Anyone you add can pick its models in chat but can’t see its sign-in.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <RadioGroup
            aria-label="Who can use this plan"
            value={reach}
            disabled={sending}
            onValueChange={value => {
              setError(null);
              setReach(value as Reach);
            }}
          >
            <div className="grid gap-3">
              {options.map(option => (
                <div key={option.value} className="flex items-center gap-3">
                  <RadioGroupItem id={`share-${subscription.connectionId}-${option.value}`} value={option.value} />
                  <Label htmlFor={`share-${subscription.connectionId}-${option.value}`}>{option.label}</Label>
                </div>
              ))}
            </div>
          </RadioGroup>
          {reach === 'specific' && (
            <div className="grid gap-2 pl-7">
              <GrantsEditor
                value={chosen}
                owner={subscription.ownerMembershipId}
                people={people}
                disabled={sending}
                roles={planRoles}
                description=""
                everyone={false}
                showOwner={false}
                addLabel="Add people or teams"
                onChange={next => {
                  setError(null);
                  setChosen(next);
                }}
              />
              {empty && (
                <p className="text-sm text-muted-foreground">
                  {nobodyElse ? 'No one else is in this workspace yet.' : 'Add at least one person or team.'}
                </p>
              )}
            </div>
          )}
          {reach !== 'private' && (
            <p className="text-sm text-muted-foreground">
              {provider} may limit accounts that are shared, and everyone you add uses this plan’s limits.
            </p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={sending} onClick={close}>
            {asking ? 'Not now' : 'Cancel'}
          </Button>
          <Button disabled={sending || empty || (!asking && unchanged)} aria-busy={sending} onClick={() => void save()}>
            {sending ? 'Saving…' : 'Save'}
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
