import { useRef, useState } from 'react';
import { createSourceSchema } from '@tulipfarm/atlassian/operation-contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { atlassianApi, atlassianError, rejected, type Account } from '@/lib/atlassian';
import { protocolNames } from './accounts';
import { useIntegrationChanges } from '@/features/integrations/queries';

export function SourceSetup({
  workspaceId,
  accounts,
  available,
}: {
  workspaceId: string;
  accounts: Account[];
  available: boolean;
  onCreated: () => void;
}) {
  const changes = useIntegrationChanges();
  const [accountId, setAccountId] = useState('');
  const [product, setProduct] = useState('jira');
  const [name, setName] = useState('');
  const [cloudId, setCloudId] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [boardId, setBoardId] = useState('');
  const [state, setState] = useState<'idle' | 'pending' | 'uncertain' | 'saved'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reviewed, setReviewed] = useState(false);
  const lock = useRef(false);
  const usable = accounts.filter(
    account => account.capabilities.use && account.configured && account.state === 'active',
  );
  const account = usable.find(item => item.id === accountId);
  async function create() {
    if (!available || !account || lock.current || state !== 'idle') return;
    const binding =
      account.protocol === 'trello'
        ? { kind: 'trello', boardId }
        : account.protocol === 'atlassian-rest'
          ? { kind: 'confluence-trash', cloudId, spaceId }
          : { kind: product, cloudId };
    const parsed = createSourceSchema.safeParse({ accountId, name, binding });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map(issue => [String(issue.path.at(-1)), issue.message])));
      return;
    }
    lock.current = true;
    setErrors({});
    setState('pending');
    setMessage(null);
    try {
      await atlassianApi.createSource(workspaceId, parsed.data);
      await changes.authority('atlassian');
      setState('saved');
      setMessage('Source saved. Select it below to run an operation.');
    } catch (error) {
      setState(rejected(error) ? 'idle' : 'uncertain');
      setMessage(atlassianError(error));
    } finally {
      lock.current = false;
    }
  }
  if (!available) return null;
  if (accountId && !account)
    return (
      <StatePanel
        kind="unavailable"
        title="Source account unavailable"
        description="Refresh Atlassian integrations after account use access is restored. Your source draft is retained privately."
      />
    );
  return (
    <section className="space-y-4" aria-label="Select Atlassian source">
      <h3 className="text-base font-medium">Select a source</h3>
      <p className="text-muted-foreground">
        A named source fixes the account and site or board for your operations. Sources belong to you. Create another
        source to change its binding.
      </p>
      {!usable.length && (
        <p>
          Connect an active account with use permission first. Business accounts need an explicit member or team use
          grant.
        </p>
      )}
      <form
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          void create();
        }}
      >
        <fieldset
          disabled={state === 'pending' || state === 'uncertain' || state === 'saved'}
          className="grid min-w-0 gap-4 sm:grid-cols-2"
        >
          <div className="space-y-2">
            <Label htmlFor="atlassian-source-account">Source account</Label>
            <Select
              value={accountId}
              onValueChange={value => {
                setAccountId(value ?? '');
                setCloudId('');
              }}
            >
              <SelectTrigger id="atlassian-source-account" width="full">
                <SelectValue placeholder="Select an account">
                  {account
                    ? `${(account.identity?.label ?? protocolNames[account.protocol]).slice(0, 32)} · ${account.id.slice(0, 8)}`
                    : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Select an account</SelectItem>
                {usable.map(item => (
                  <SelectItem key={item.id} value={item.id}>
                    {(item.identity?.label ?? protocolNames[item.protocol]).slice(0, 32)} · {item.id.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="atlassian-source-name">Source name</Label>
            <Input
              id="atlassian-source-name"
              value={name}
              maxLength={100}
              onChange={event => setName(event.target.value)}
              aria-invalid={Boolean(errors.name)}
              aria-describedby="source-name-error"
            />
            <p id="source-name-error" className="text-sm text-destructive">
              {errors.name}
            </p>
          </div>
          {account?.protocol === 'atlassian-mcp' && (
            <div className="space-y-2">
              <Label htmlFor="atlassian-source-product">Product</Label>
              <Select value={product} onValueChange={value => setProduct(value ?? 'jira')}>
                <SelectTrigger id="atlassian-source-product" width="full">
                  <SelectValue>{product === 'jira' ? 'Jira' : 'Confluence'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="jira">Jira</SelectItem>
                  <SelectItem value="confluence">Confluence</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {account && account.protocol !== 'trello' && (
            <div className="space-y-2">
              <Label htmlFor="atlassian-source-site">
                {account.protocol === 'atlassian-rest' ? 'Verified site' : 'Site cloud ID'}
              </Label>
              {account.protocol === 'atlassian-rest' ? (
                <Select value={cloudId} onValueChange={value => setCloudId(value ?? '')}>
                  <SelectTrigger
                    id="atlassian-source-site"
                    width="full"
                    aria-invalid={Boolean(errors.cloudId)}
                    aria-describedby="source-site-help source-site-error"
                  >
                    <SelectValue placeholder="Select a site">
                      {account.resources.find(site => site.id === cloudId)?.name.slice(0, 40)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Select a site</SelectItem>
                    {account.resources.map(site => (
                      <SelectItem key={site.id} value={site.id}>
                        {site.name.slice(0, 40)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="atlassian-source-site"
                  value={cloudId}
                  onChange={event => setCloudId(event.target.value)}
                  aria-invalid={Boolean(errors.cloudId)}
                  aria-describedby="source-site-help source-site-error"
                />
              )}
              <p id="source-site-help" className="text-sm text-muted-foreground">
                {account.protocol === 'atlassian-mcp'
                  ? 'Enter the site cloud UUID. MCP does not verify this site selection. Jira and Confluence MCP sources cover the whole site.'
                  : 'Only sites returned by this account are available. This fallback supports moving pages to trash.'}
              </p>
              <p id="source-site-error" className="text-sm text-destructive">
                {errors.cloudId}
              </p>
            </div>
          )}
          {account?.protocol === 'atlassian-rest' && (
            <div className="space-y-2">
              <Label htmlFor="atlassian-source-space">Space ID</Label>
              <Input
                id="atlassian-source-space"
                value={spaceId}
                onChange={event => setSpaceId(event.target.value)}
                aria-invalid={Boolean(errors.spaceId)}
                aria-describedby="source-space-error"
              />
              <p id="source-space-error" className="text-sm text-destructive">
                {errors.spaceId}
              </p>
            </div>
          )}
          {account?.protocol === 'trello' && (
            <div className="space-y-2">
              <Label htmlFor="atlassian-source-board">Board ID</Label>
              <Input
                id="atlassian-source-board"
                value={boardId}
                onChange={event => setBoardId(event.target.value)}
                aria-invalid={Boolean(errors.boardId)}
                aria-describedby="source-board-help source-board-error"
              />
              <p id="source-board-help" className="text-sm text-muted-foreground">
                Enter the full 24-character Trello board ID. Board discovery is not available.
              </p>
              <p id="source-board-error" className="text-sm text-destructive">
                {errors.boardId}
              </p>
            </div>
          )}
        </fieldset>
        {message && (
          <Alert variant={state === 'saved' ? 'default' : 'destructive'}>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {state === 'uncertain' && (
          <p>
            Source creation is unconfirmed. Refresh sources and inspect the saved bindings. This request cannot be
            safely replayed automatically.
          </p>
        )}
        {state === 'uncertain' && (
          <>
            <Label>
              <Checkbox checked={reviewed} onCheckedChange={checked => setReviewed(checked === true)} />I refreshed
              sources and checked whether this source was saved.
            </Label>
            <Button
              variant="outline"
              disabled={!reviewed}
              onClick={() => {
                setState('idle');
                setReviewed(false);
                setMessage(null);
              }}
            >
              Finish source status review
            </Button>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!account || state !== 'idle'} aria-busy={state === 'pending'}>
            Save source
          </Button>
          {state === 'saved' && (
            <Button
              variant="outline"
              onClick={() => {
                setName('');
                setState('idle');
                setMessage(null);
              }}
            >
              Select another source
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
