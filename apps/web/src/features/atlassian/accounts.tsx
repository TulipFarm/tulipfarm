import { useEffect, useRef, useState } from 'react';
import { useAtlassianGrants, useIntegrationChanges } from '@/features/integrations/queries';
import type { IntegrationCollaborators } from '@/lib/integrations';
import { accountProtocolSchema, type AccountProtocol } from '@tulipfarm/atlassian/account-contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { atlassianApi, atlassianError, rejected, type Account, type AccountList, type Grants } from '@/lib/atlassian';

export const protocolNames: Record<AccountProtocol, string> = {
  'atlassian-mcp': 'Jira and Confluence',
  'atlassian-rest': 'Confluence page deletion',
  trello: 'Trello',
};
type Authorization = { kind: 'idle' } | { kind: 'pending' } | { kind: 'error'; message: string; uncertain: boolean };
export function consentUrl(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    !['https://mcp.atlassian.com/v1/authorize', 'https://auth.atlassian.com/authorize'].includes(
      `${url.origin}${url.pathname}`,
    )
  )
    throw new Error('Invalid consent URL');
  return url.href;
}

export function AccountSetup({
  workspaceId,
  data,
  onChanged,
  selectedProtocol,
}: {
  workspaceId: string;
  data: AccountList;
  onChanged: () => void;
  selectedProtocol: AccountProtocol | undefined;
}) {
  const changes = useIntegrationChanges();
  const [chosenProtocol, setProtocol] = useState<AccountProtocol>(selectedProtocol ?? 'atlassian-mcp');
  const protocol = selectedProtocol ?? chosenProtocol;
  const [business, setBusiness] = useState(false);
  const [authorization, setAuthorization] = useState<Authorization>({ kind: 'idle' });
  const lock = useRef(false);
  const configured = data.providers.find(provider => provider.protocol === protocol)?.configured === true;
  const current = useRef({ mounted: true, configured });
  current.current.configured = configured;
  useEffect(() => {
    current.current.mounted = true;
    return () => {
      current.current.mounted = false;
    };
  }, []);
  async function begin() {
    if (lock.current || !configured) return;
    lock.current = true;
    setAuthorization({ kind: 'pending' });
    try {
      const ownership = business ? 'business' : 'personal';
      const unfinished = data.accounts.find(
        account =>
          account.protocol === protocol &&
          account.ownership === ownership &&
          account.capabilities.manage &&
          ['authorizing', 'reconnect-required', 'disconnected'].includes(account.state),
      );
      const value = unfinished
        ? await atlassianApi.reconnect(workspaceId, unfinished.id)
        : await atlassianApi.begin(workspaceId, { protocol, ownership: { kind: ownership } });
      if (current.current.mounted && current.current.configured) window.location.assign(consentUrl(value.url));
      void changes.atlassianAccounts();
    } catch (error) {
      setAuthorization({ kind: 'error', message: atlassianError(error), uncertain: !rejected(error) });
    } finally {
      lock.current = false;
    }
  }
  return (
    <section className="space-y-4" aria-labelledby="atlassian-connect-heading">
      <h3 id="atlassian-connect-heading" className="text-base font-medium">
        Connect an account
      </h3>
      <p className="text-base text-muted-foreground">
        {protocol === 'atlassian-mcp'
          ? 'Sign in with Atlassian to connect Jira and Confluence together.'
          : `Sign in to connect ${protocolNames[protocol]}.`}{' '}
        Your personal account is private to you.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        {!selectedProtocol && (
          <div className="space-y-2">
            <Label htmlFor="atlassian-protocol">Provider</Label>
            <Select
              value={protocol}
              disabled={authorization.kind === 'pending'}
              onValueChange={value => {
                setProtocol(accountProtocolSchema.parse(value));
                setAuthorization({ kind: 'idle' });
              }}
            >
              <SelectTrigger id="atlassian-protocol" width="full">
                <SelectValue>{protocolNames[protocol]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {data.providers.map(provider => (
                  <SelectItem key={provider.protocol} value={provider.protocol}>
                    {protocolNames[provider.protocol]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <Label>
          <Checkbox
            checked={business}
            disabled={authorization.kind === 'pending'}
            onCheckedChange={checked => setBusiness(checked === true)}
          />
          Shared business account
        </Label>
        <Button
          disabled={
            !configured ||
            authorization.kind === 'pending' ||
            (authorization.kind === 'error' && authorization.uncertain)
          }
          aria-busy={authorization.kind === 'pending'}
          onClick={() => void begin()}
        >
          {authorization.kind === 'pending' && <Spinner aria-hidden="true" />}
          {authorization.kind === 'pending' ? 'Opening sign-in…' : 'Connect account'}
        </Button>
      </div>
      {!configured && (
        <p role="status">
          This provider is not configured on TulipFarm yet. Contact your workspace admin, then check the integration
          again.
        </p>
      )}
      {authorization.kind === 'error' && (
        <>
          <Alert variant="destructive">
            <AlertDescription>
              {authorization.message}
              {authorization.uncertain && ' Check the account list, then reconnect the unfinished account.'}
            </AlertDescription>
          </Alert>
          <Button variant="outline" onClick={onChanged}>
            Check integration status
          </Button>
        </>
      )}
    </section>
  );
}

export function AccountRow({
  workspaceId,
  account,
  governance,
  onChanged,
}: {
  workspaceId: string;
  account: Account;
  governance: IntegrationCollaborators | null;
  onChanged: () => void;
}) {
  const changes = useIntegrationChanges();
  const [authorization, setAuthorization] = useState<Authorization>({ kind: 'idle' });
  const [disconnect, setDisconnect] = useState<'idle' | 'confirm' | 'pending' | 'uncertain' | 'done'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [grantsOpen, setGrantsOpen] = useState(false);
  const lock = useRef(false);
  const current = useRef({ mounted: true, permitted: account.capabilities.manage && account.configured });
  current.current.permitted = account.capabilities.manage && account.configured;
  useEffect(() => {
    current.current.mounted = true;
    return () => {
      current.current.mounted = false;
    };
  }, []);
  async function change(action: 'reconnect' | 'disconnect') {
    if (lock.current || !account.capabilities.manage) return;
    lock.current = true;
    setMessage(null);
    if (action === 'reconnect') setAuthorization({ kind: 'pending' });
    else setDisconnect('pending');
    try {
      if (action === 'reconnect') {
        const value = await atlassianApi.reconnect(workspaceId, account.id);
        if (current.current.mounted && current.current.permitted) window.location.assign(consentUrl(value.url));
      } else {
        await atlassianApi.disconnect(workspaceId, account.id);
        setDisconnect('done');
        setAuthorization({ kind: 'idle' });
      }
      await changes.atlassianAccounts();
    } catch (error) {
      setMessage(atlassianError(error));
      if (action === 'reconnect')
        setAuthorization({ kind: 'error', message: atlassianError(error), uncertain: !rejected(error) });
      else setDisconnect(rejected(error) ? 'confirm' : 'uncertain');
    } finally {
      lock.current = false;
    }
  }
  const busy = authorization.kind === 'pending' || disconnect === 'pending';
  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="break-words font-medium">{account.identity?.label ?? protocolNames[account.protocol]}</h3>
          <p className="text-muted-foreground">
            {account.ownership === 'personal' ? 'Personal account' : 'Business account'}
            {account.state === 'active' && !account.capabilities.use ? ' · Ask an integration manager for access' : ''}
          </p>
        </div>
        <Badge variant={account.state === 'active' ? 'success' : 'secondary'}>
          {
            {
              active: 'Connected',
              authorizing: 'Sign-in incomplete',
              refreshing: 'Refreshing',
              'reconnect-required': 'Reconnect needed',
              disconnected: 'Disconnected',
            }[account.state]
          }
        </Badge>
      </div>
      {!account.configured && (
        <p>This account's provider is not configured. Ask your operator to restore configuration.</p>
      )}
      {account.state === 'authorizing' && (
        <p className="text-muted-foreground">Sign-in was not completed. Reconnect to continue with this account.</p>
      )}
      {account.capabilities.manage && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || !account.configured}
            aria-busy={authorization.kind === 'pending'}
            onClick={() => void change('reconnect')}
          >
            Reconnect
          </Button>
          <Button
            variant="outline"
            disabled={busy || account.state === 'disconnected' || disconnect === 'uncertain'}
            onClick={() => setDisconnect('confirm')}
          >
            Disconnect
          </Button>
          {account.ownership === 'business' && governance && (
            <Button variant="outline" aria-expanded={grantsOpen} onClick={() => setGrantsOpen(value => !value)}>
              Manage use grants
            </Button>
          )}
        </div>
      )}
      {account.capabilities.manage && (
        <>
          {disconnect === 'confirm' && (
            <div className="space-y-2">
              <p>
                Disconnect clears stored credentials and stops future use. Pending writes become invalid. Remote
                provider consent must be revoked separately.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="destructive" onClick={() => void change('disconnect')}>
                  Confirm disconnect
                </Button>
                <Button variant="ghost" onClick={() => setDisconnect('idle')}>
                  Cancel disconnect
                </Button>
              </div>
            </div>
          )}
          {disconnect === 'pending' && <p role="status">Disconnecting account…</p>}
          {disconnect === 'done' && (
            <p role="status">
              Account disconnected. Revoke the application's access in the provider account settings if remote
              revocation is needed.
            </p>
          )}
          {disconnect === 'uncertain' && (
            <p>
              Disconnect is unconfirmed. Refresh Atlassian integrations to check the account state before another
              change.
            </p>
          )}
          {message && (
            <Alert variant="destructive">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}
        </>
      )}
      {grantsOpen && account.capabilities.manage && governance && (
        <BusinessGrants workspaceId={workspaceId} account={account} governance={governance} onChanged={onChanged} />
      )}
    </li>
  );
}

function BusinessGrants({
  workspaceId,
  account,
  governance,
}: {
  workspaceId: string;
  account: Account;
  governance: IntegrationCollaborators;
  onChanged: () => void;
}) {
  const read = useAtlassianGrants(workspaceId, account.id, true);
  const changes = useIntegrationChanges();
  const [edited, setDraft] = useState<Grants | null>(null);
  const draft = edited ?? read.data;
  const [command, setStatus] = useState<'ready' | 'saving' | 'error' | 'uncertain'>('ready');
  const status = read.busy && !draft ? 'loading' : read.error ? 'error' : command;
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);
  const reload = async () => {
    if (lock.current) return;
    lock.current = true;
    setMessage(null);
    try {
      const saved = await read.refresh();
      if (!saved) throw new Error('Grants unavailable');
      setDraft(saved);
      setStatus('ready');
    } catch (error) {
      setMessage(atlassianError(error));
      setStatus('error');
    } finally {
      lock.current = false;
    }
  };
  const conflict = draft !== null && draft.expectedVersion !== account.grantsVersion;
  async function save() {
    if (!draft || lock.current || conflict) return;
    lock.current = true;
    setStatus('saving');
    setMessage(null);
    try {
      const saved = await atlassianApi.saveGrants(workspaceId, account.id, draft);
      await changes.atlassianAccounts();
      setDraft({ ...draft, expectedVersion: saved.grantsVersion });
      setMessage('Use grants saved. Source selection and write approval remain separate.');
      setStatus('ready');
    } catch (error) {
      setMessage(atlassianError(error));
      setStatus('uncertain');
    } finally {
      lock.current = false;
    }
  }
  function toggle(key: 'memberIds' | 'teamIds', id: string, checked: boolean) {
    if (draft) setDraft({ ...draft, [key]: checked ? [...draft[key], id] : draft[key].filter(value => value !== id) });
  }
  function toggleManager(key: 'memberIds' | 'teamIds', id: string, checked: boolean) {
    if (!draft) return;
    const managers = draft.managers ?? { memberIds: [], teamIds: [] };
    setDraft({
      ...draft,
      managers: { ...managers, [key]: checked ? [...managers[key], id] : managers[key].filter(value => value !== id) },
    });
  }
  return (
    <section className="space-y-3 border-t border-border pt-4" aria-label="Business account use grants">
      <h4 className="font-medium">Explicit use grants</h4>
      <p className="text-muted-foreground">
        Select every member or team allowed to use this business account, including admins. Saving replaces both lists.
      </p>
      {status === 'loading' && <p role="status">Loading use grants…</p>}
      {!draft && status === 'error' && (
        <StatePanel kind="error" title="Could not load use grants" description="Reload the grants to recover.">
          <Button variant="outline" onClick={() => void reload()}>
            Retry use grants
          </Button>
        </StatePanel>
      )}
      {draft && (
        <fieldset disabled={status !== 'ready' || conflict} className="grid gap-4 sm:grid-cols-2">
          <legend className="sr-only">Members and teams with use access</legend>
          <div className="space-y-3">
            <p className="font-medium">Members</p>
            {governance.members.map(member => (
              <div key={member.id} className="space-y-2">
                <Label>
                  <Checkbox
                    checked={draft.memberIds.includes(member.id)}
                    onCheckedChange={checked => toggle('memberIds', member.id, checked === true)}
                  />
                  Allow {member.name} to use account
                </Label>
                <Label>
                  <Checkbox
                    checked={draft.managers?.memberIds.includes(member.id) ?? false}
                    onCheckedChange={checked => toggleManager('memberIds', member.id, checked === true)}
                  />
                  Allow {member.name} to manage and share
                </Label>
              </div>
            ))}
          </div>
          <div className="space-y-3">
            <p className="font-medium">Teams</p>
            {governance.teams.map(team => (
              <div key={team.id} className="space-y-2">
                <Label>
                  <Checkbox
                    checked={draft.teamIds.includes(team.id)}
                    onCheckedChange={checked => toggle('teamIds', team.id, checked === true)}
                  />
                  Allow {team.name} to use account
                </Label>
                <Label>
                  <Checkbox
                    checked={draft.managers?.teamIds.includes(team.id) ?? false}
                    onCheckedChange={checked => toggleManager('teamIds', team.id, checked === true)}
                  />
                  Allow {team.name} to manage and share
                </Label>
              </div>
            ))}
          </div>
        </fieldset>
      )}
      {conflict && (
        <Alert variant="destructive">
          <AlertDescription>
            Another manager changed these grants. Your selection is retained. Reload use grants to replace it with the
            saved version.
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert variant={status === 'ready' ? 'default' : 'destructive'}>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!draft || status !== 'ready' || conflict}
          aria-busy={status === 'saving'}
          onClick={() => void save()}
        >
          Save use grants
        </Button>
        <Button variant="outline" disabled={status === 'loading' || status === 'saving'} onClick={() => void reload()}>
          Reload use grants
        </Button>
      </div>
    </section>
  );
}
