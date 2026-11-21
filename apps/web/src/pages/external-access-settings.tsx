import { useId, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { CodeBlock } from '@tulipfarm/sprout/code-block';
import { CheckboxField } from '@tulipfarm/sprout/field';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@tulipfarm/sprout/dialog';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Switch } from '@tulipfarm/sprout/switch';
import { workspaceRoute } from '@/router';
import { apiOrigin } from '@/lib/auth';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import {
  accessTokenScopes,
  expiryOptions,
  externalAccessApi,
  requestMessage,
  type AccessToken,
  type AccessTokenScope,
  type Expiry,
} from '@/features/external-access/api';

const keys = { all: ['external-access'] as const };
const scopeLabel = new Map<string, string>(accessTokenScopes.map(scope => [scope.id, scope.label]));
const date = (value: string | null) =>
  value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;

export function ExternalAccessSettingsPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = externalAccessApi(workspace.id);
  const settings = useFeatureRead({ key: [...keys.all, 'settings'], load: api.settings });
  const { change } = useFeatureChanges();
  const changed = () => change({ keys: [keys.all] });
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          title="API and MCP"
          description="Connect your own apps and AI tools to this workspace. Tokens act as you, with only the permissions you give them."
        />
        {settings.state.kind === 'loading' ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton />
            <Skeleton />
          </div>
        ) : settings.state.kind === 'error' ? (
          <StatePanel
            kind="error"
            heading="h2"
            title="Could not load API settings"
            description="Check your connection."
          >
            <Button variant="outline" onClick={() => void settings.refresh()}>
              Try again
            </Button>
          </StatePanel>
        ) : settings.state.kind === 'unavailable' || !settings.state.data.available ? (
          <StatePanel
            kind="unavailable"
            heading="h2"
            title="API and MCP access isn't available yet"
            description="It hasn't been turned on for this workspace."
          />
        ) : (
          <div className="space-y-6">
            <AccessSwitch
              enabled={settings.state.data.enabled}
              admin={settings.state.data.admin}
              setEnabled={async enabled => {
                await api.setEnabled(enabled);
                await changed();
              }}
            />
            {settings.state.data.enabled && (
              <>
                <Tokens workspaceId={workspace.id} all={false} onChange={changed} />
                <ConnectHelp workspaceId={workspace.id} />
                {settings.state.data.admin && <Tokens workspaceId={workspace.id} all onChange={changed} />}
              </>
            )}
          </div>
        )}
      </PageContent>
    </div>
  );
}

function AccessSwitch({
  enabled,
  admin,
  setEnabled,
}: {
  enabled: boolean;
  admin: boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
}) {
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsGroup title="Workspace access">
      <SettingsRow
        label="Allow API and MCP access"
        htmlFor={id}
        description={
          admin
            ? 'When this is on, members can create tokens for their own access. Turning it off stops every token at once.'
            : enabled
              ? 'An admin has turned this on.'
              : 'Ask a workspace admin to turn this on.'
        }
      >
        <Switch
          id={id}
          checked={enabled}
          disabled={!admin || pending}
          onCheckedChange={next => {
            setPending(true);
            setError(null);
            void setEnabled(next)
              .catch(caught => setError(requestMessage(caught)))
              .finally(() => setPending(false));
          }}
        />
      </SettingsRow>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </SettingsGroup>
  );
}

function Tokens({
  workspaceId,
  all,
  onChange,
}: {
  workspaceId: string;
  all: boolean;
  onChange: () => Promise<unknown>;
}) {
  const api = externalAccessApi(workspaceId);
  const tokens = useFeatureRead({
    key: [...keys.all, 'tokens', all ? 'all' : 'mine'],
    load: signal => api.tokens(all, signal),
  });
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const title = all ? 'All members’ tokens' : 'Your tokens';
  return (
    <SettingsGroup title={title}>
      {!all && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            Each token works only in this workspace and can never do more than you can.
          </p>
          <Button onClick={() => setCreating(true)}>Create token</Button>
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {tokens.state.kind === 'loading' ? (
        <div className="space-y-3 p-4" aria-busy="true">
          <Skeleton />
        </div>
      ) : tokens.state.kind === 'error' ? (
        <StatePanel kind="error" heading="h3" title="Could not load tokens" description="Check your connection.">
          <Button variant="outline" onClick={() => void tokens.refresh()}>
            Try again
          </Button>
        </StatePanel>
      ) : tokens.state.kind === 'unavailable' ? (
        <StatePanel
          kind="unavailable"
          heading="h3"
          title="Tokens are not available to you"
          description="You may have lost access to this workspace."
        />
      ) : tokens.state.data.length === 0 ? (
        <StatePanel
          kind="empty"
          heading="h3"
          title={all ? 'No one has created a token' : 'No tokens yet'}
          description={all ? 'Tokens members create appear here.' : 'Create one to connect an app or an AI tool.'}
        />
      ) : (
        <ul className="divide-y">
          {tokens.state.data.map(token => (
            <TokenRow
              key={token.id}
              token={token}
              showOwner={all}
              revoking={revoking === token.id}
              onRevoke={() => {
                setRevoking(token.id);
                setError(null);
                void api
                  .revoke(token.id)
                  .then(onChange)
                  .catch(caught => setError(requestMessage(caught)))
                  .finally(() => setRevoking(null));
              }}
            />
          ))}
        </ul>
      )}
      {creating && <CreateToken workspaceId={workspaceId} onClose={() => setCreating(false)} onCreated={onChange} />}
    </SettingsGroup>
  );
}

function TokenRow({
  token,
  showOwner,
  revoking,
  onRevoke,
}: {
  token: AccessToken;
  showOwner: boolean;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const expired = token.expiresAt !== null && new Date(token.expiresAt).getTime() <= Date.now();
  const state = token.revokedAt ? 'Revoked' : expired ? 'Expired' : null;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-4">
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {token.name}
          {state && <Badge variant="secondary">{state}</Badge>}
        </p>
        <p className="text-sm text-muted-foreground">
          {[
            showOwner ? (token.ownerName ?? 'Unknown member') : null,
            token.scopes.map(scope => scopeLabel.get(scope) ?? scope).join(', '),
            token.tableIds ? `${token.tableIds.length} table${token.tableIds.length === 1 ? '' : 's'}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p className="text-sm text-muted-foreground">
          {[
            `Created ${date(token.createdAt)}`,
            token.expiresAt ? `${expired ? 'Expired' : 'Expires'} ${date(token.expiresAt)}` : 'No expiry',
            token.lastUsedAt ? `Last used ${date(token.lastUsedAt)}` : 'Never used',
          ].join(' · ')}
        </p>
      </div>
      {!state && (
        <Button variant="outline" size="sm" disabled={revoking} onClick={onRevoke}>
          {revoking ? 'Revoking…' : 'Revoke'}
        </Button>
      )}
    </li>
  );
}

function CreateToken({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: () => Promise<unknown>;
}) {
  const api = externalAccessApi(workspaceId);
  const nameId = useId();
  const expiryId = useId();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<AccessTokenScope>>(new Set(['tables:read']));
  const [expiry, setExpiry] = useState<Expiry>('90d');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const valid = name.trim().length > 0 && scopes.size > 0;
  return (
    <Dialog open onOpenChange={open => !open && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{created ? 'Copy your token' : 'Create token'}</DialogTitle>
          <DialogDescription>
            {created
              ? 'This is the only time it is shown. Store it somewhere safe, such as a password manager.'
              : 'The token acts as you in this workspace, with only these permissions.'}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="space-y-3">
            <Input readOnly spellCheck={false} autoComplete="off" value={created} aria-label="New token" />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                onClick={() =>
                  void navigator.clipboard.writeText(created).then(
                    () => setCopied('yes'),
                    () => setCopied('failed'),
                  )
                }
              >
                Copy token
              </Button>
              {copied === 'yes' && <span className="text-sm">Copied</span>}
              {copied === 'failed' && <span className="text-sm">Couldn't copy. Select the token and copy it.</span>}
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={event => {
              event.preventDefault();
              if (!valid || pending) return;
              setPending(true);
              setError(null);
              void api
                .create({ name: name.trim(), scopes: [...scopes], expiry })
                .then(async result => {
                  setCreated(result.token);
                  await onCreated();
                })
                .catch(caught => setError(requestMessage(caught)))
                .finally(() => setPending(false));
            }}
          >
            <div className="space-y-2">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                value={name}
                maxLength={80}
                placeholder="For example, Laptop sync or Claude Code"
                onChange={event => setName(event.target.value)}
              />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Permissions</legend>
              {accessTokenScopes.map(scope => (
                <CheckboxField
                  key={scope.id}
                  variant="neutral"
                  label={scope.label}
                  helper={scope.description}
                  checked={scopes.has(scope.id)}
                  onCheckedChange={checked => {
                    const next = new Set(scopes);
                    if (checked) next.add(scope.id);
                    else next.delete(scope.id);
                    setScopes(next);
                  }}
                />
              ))}
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor={expiryId}>Expires after</Label>
              <Select value={expiry} onValueChange={value => setExpiry(value as Expiry)}>
                <SelectTrigger id={expiryId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {expiryOptions.map(option => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid || pending}>
                {pending ? 'Creating…' : 'Create token'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConnectHelp({ workspaceId }: { workspaceId: string }) {
  const rest = `${apiOrigin}/v1/public/workspaces/${workspaceId}`;
  return (
    <SettingsGroup title="Connect">
      <div className="space-y-3 p-4">
        <p className="text-sm">Add TulipFarm to Claude Code as an MCP server:</p>
        <CodeBlock
          code={`claude mcp add --transport http tulipfarm ${apiOrigin}/v1/mcp \\\n  --header "Authorization: Bearer $TULIPFARM_TOKEN"`}
          filename="Claude Code"
          lineNumbers={false}
        />
        <p className="text-sm">Or call the REST API from your own app:</p>
        <CodeBlock
          code={`curl ${rest}/tables \\\n  -H "Authorization: Bearer $TULIPFARM_TOKEN"`}
          filename="curl"
          lineNumbers={false}
        />
        <p className="text-sm text-muted-foreground">
          Set TULIPFARM_TOKEN to your token first. Full reference: {apiOrigin}/v1/docs.
        </p>
      </div>
    </SettingsGroup>
  );
}
