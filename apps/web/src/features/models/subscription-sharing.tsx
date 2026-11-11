import { useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { FormSection } from '@tulipfarm/sprout/form';
import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { useFeatureChanges, useFeatureRead, useFeatureScope } from '@/lib/query';
import { useOwnMembership } from '@/features/governance/queries';
import type { SecretGrant } from '@/features/secrets/contracts';
import { GrantsEditor, granteeKey, type People, type RoleOptions } from '@/features/secrets/grants-editor';
import { useMemberDirectory } from '@/features/secrets/queries';
import { TableRequestError } from '@/features/tables/request-state';
import { modelKeys } from './queries';

export const subscriptionsKey = ['models', 'subscriptions'] as const;

const providerLabels = { chatgpt: 'ChatGPT', claude: 'Claude', copilot: 'GitHub Copilot' } as const;
type Provider = keyof typeof providerLabels;

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
  canShare: z.boolean(),
  grants: z.array(grantSchema).nullable(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

const errors: Record<string, string> = {
  'subscription-not-found': 'This plan is no longer connected. Reload to see the current plans.',
  'subscription-not-connected': 'This plan needs sign-in again before it can be shared.',
  'subscription-invalid-grant':
    'This plan can’t be shared with one of the people or teams you chose. Check that they’re still in this workspace, then try again.',
  'subscription-access-denied': 'You can’t change who uses this plan. Ask its owner to change who it’s shared with.',
};
const errorMessage = (code: string) => errors[code] ?? 'Sharing couldn’t be saved. Try again.';

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
  };
}

const planRoles = {
  use: { label: 'Use it', hint: 'Pick its models in chats and agents' },
  manage: { label: 'Use and share it', hint: 'Also change who it’s shared with' },
} as const satisfies RoleOptions;

function usePeople(workspaceId: string): People {
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

function audience(grants: readonly SecretGrant[], people: People) {
  if (!grants.length) return 'No one';
  return grants
    .map(grant =>
      grant.grantee.kind === 'workspace'
        ? 'Everyone'
        : grant.grantee.kind === 'team'
          ? (people.teams.find(team => grant.grantee.kind === 'team' && team.id === grant.grantee.teamId)?.name ??
            'Another team')
          : people.name(grant.grantee.membershipId),
    )
    .join(', ');
}

function ShareDialog({
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
          <DialogTitle>Who can use this {provider} plan</DialogTitle>
          <DialogDescription>
            People you share with can pick its models in their chats and agents. No one can see its sign-in details.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <GrantsEditor
            value={grants}
            owner={subscription.ownerMembershipId}
            people={people}
            disabled={sending}
            roles={planRoles}
            description="Requests use the asker’s own plan first, then plans shared with them, then with their teams, then with everyone. If none can answer, the workspace’s fallback model does when one is set."
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
                {provider} may limit or close accounts that are shared. Everyone you share with uses this plan’s limits.
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

/** Who a member's own plan is shared with, and a Share button. */
export function PlanSharing({ workspaceId, provider }: { workspaceId: string; provider: Provider }) {
  const { read } = useSubscriptions(workspaceId);
  const people = usePeople(workspaceId);
  const [open, setOpen] = useState(false);
  if (read.state.kind !== 'ready') return null;
  const own = read.state.data.find(item => item.provider === provider && item.ownerMembershipId === people.you);
  if (!own?.canShare) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-sm text-muted-foreground">
        Shared with: <span className="text-foreground">{audience(own.grants ?? [], people)}</span>
      </p>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={own.state === 'signed-out'}>
        Share
      </Button>
      {open && (
        <ShareDialog workspaceId={workspaceId} subscription={own} people={people} close={() => setOpen(false)} />
      )}
    </div>
  );
}

const states: Record<Subscription['state'], { label: string; variant: 'success' | 'warning' | 'secondary' }> = {
  connected: { label: 'Connected', variant: 'success' },
  'reconnect-required': { label: 'Needs sign-in again', variant: 'warning' },
  'plan-disabled': { label: 'Turned off', variant: 'secondary' },
  'signed-out': { label: 'Signed out', variant: 'secondary' },
};

/** Plans other members connected that this member may use or, as an admin or manager, share. */
export function SharedPlansSection({ workspaceId }: { workspaceId: string }) {
  const { read } = useSubscriptions(workspaceId);
  const people = usePeople(workspaceId);
  const [sharing, setSharing] = useState<Subscription | null>(null);
  if (read.state.kind !== 'ready') return null;
  const others = read.state.data.filter(item => item.ownerMembershipId !== people.you && item.state !== 'signed-out');
  if (!others.length) return null;
  return (
    <FormSection
      title="Plans from other members"
      description="Plans other members connected that you can use or share. Their models appear in chats and agents."
    >
      <ul className="grid gap-3">
        {others.map(item => (
          <li key={item.connectionId} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{providerLabels[item.provider]}</span>
            <span className="text-muted-foreground">
              {people.name(item.ownerMembershipId)}
              {item.account ? ` · ${item.account}` : ''}
            </span>
            <Badge variant={states[item.state].variant}>{states[item.state].label}</Badge>
            {item.grants && <span className="text-muted-foreground">Shared with: {audience(item.grants, people)}</span>}
            {item.canShare && (
              <Button size="sm" variant="outline" onClick={() => setSharing(item)}>
                Share
              </Button>
            )}
          </li>
        ))}
      </ul>
      {sharing && (
        <ShareDialog workspaceId={workspaceId} subscription={sharing} people={people} close={() => setSharing(null)} />
      )}
    </FormSection>
  );
}
