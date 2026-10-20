import { useRef, useState } from 'react';
import { useSlackIntegration, useIntegrationAdministration } from './queries';
import { useFeatureRead } from '@/lib/query';
import { IntegrationRequestError } from '@/lib/integrations';
import { Link } from '@tanstack/react-router';
import { z } from 'zod';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal } from '@/lib/http';
import { SlackKnowledgeSources } from './slack-knowledge';

const statusSchema = z.object({
  state: z.string(),
  teamId: z.string().nullable(),
  canManage: z.boolean(),
  linked: z.boolean().default(false),
  scopes: z.array(z.string()),
  missingScopes: z.array(z.string()).optional(),
  recoveryEventId: z.uuid().optional(),
});
export type SlackStatus = z.infer<typeof statusSchema>;
export async function loadSlackStatus(workspaceId: string, signal?: AbortSignal): Promise<SlackStatus | 'unavailable'> {
  const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/slack/status`, {
    signal: requestSignal(signal),
    cache: 'no-store',
  });
  if (!response.ok) throw new IntegrationRequestError(response.status);
  const value = statusSchema.parse(await readJson(response));
  return value.state === 'unavailable' ? 'unavailable' : value;
}
export async function slackInstallUrl(workspaceId: string) {
  const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/slack/install`, {
    method: 'POST',
    signal: requestSignal(),
  });
  if (!response.ok) throw new Error('slack-install');
  const url = new URL(z.object({ url: z.url() }).parse(await readJson(response)).url);
  if (url.origin !== 'https://slack.com' || url.pathname !== '/oauth/v2/authorize' || url.username || url.password)
    throw new Error('slack-install');
  return url.href;
}
export async function startSlackInstall(workspaceId: string) {
  window.location.assign(await slackInstallUrl(workspaceId));
}
type State =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'opening' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; value: z.infer<typeof statusSchema> };

export function SlackIntegration({ workspaceId }: { workspaceId: string }) {
  const read = useSlackIntegration(workspaceId);
  const [command, setCommand] = useState<'opening' | 'error' | null>(null);
  const state: State = command
    ? { kind: command }
    : read.state.kind === 'ready'
      ? read.state.data === 'unavailable'
        ? { kind: 'unavailable' }
        : { kind: 'ready', value: read.state.data }
      : { kind: read.state.kind };
  const setAttempt = () => {
    setCommand(null);
    void read.refresh();
  };
  async function connect() {
    setCommand('opening');
    try {
      await startSlackInstall(workspaceId);
    } catch {
      setCommand('error');
    }
  }
  return (
    <section className="space-y-3" aria-label="Slack integration">
      {state.kind === 'loading' || state.kind === 'opening' ? (
        <StatePanel
          kind="loading"
          title={state.kind === 'opening' ? 'Opening Slack authorization' : 'Checking Slack integration'}
          description="Your workspace and existing thread assignments stay unchanged."
        />
      ) : state.kind === 'error' ? (
        <StatePanel
          kind="error"
          title="Could not check Slack integration"
          description="Check the integration status before authorizing again. This does not resend any Slack action."
        >
          <Button onClick={setAttempt}>Check Slack status</Button>
        </StatePanel>
      ) : state.kind === 'unavailable' ? (
        <StatePanel
          kind="unavailable"
          title="Slack integration unavailable"
          description="An integration manager can grant you access."
        />
      ) : state.value.state === 'active' ? (
        read.state.kind === 'ready' &&
        read.state.error && (
          <Alert variant="destructive">
            <AlertDescription>Slack status could not refresh.</AlertDescription>
            <Button variant="outline" onClick={setAttempt}>
              Check Slack status
            </Button>
          </Alert>
        )
      ) : (
        <StatePanel
          kind={state.value.state === 'disconnected' ? 'empty' : 'error'}
          title={state.value.state === 'disconnected' ? 'Connect a Slack workspace' : 'Slack workspace needs attention'}
          description="Members can create an integration. Appointed managers can reconnect it. Reconnect does not restore revoked members or approve previous actions."
        >
          {read.state.kind === 'ready' && read.state.error && (
            <p role="alert">Slack status could not refresh. Check Slack status before reconnecting.</p>
          )}
          {state.value.canManage &&
            [
              'disconnected',
              'failed',
              'revoked',
              'reconnect-required',
              'permissions-required',
              'scope-missing',
            ].includes(state.value.state) && (
              <Button
                disabled={read.state.kind === 'ready' && (!!read.state.error || read.state.refreshing)}
                onClick={() => void connect()}
              >
                {state.value.state === 'disconnected'
                  ? 'Connect Slack'
                  : state.value.state === 'permissions-required' || state.value.state === 'scope-missing'
                    ? 'Update Slack permissions'
                    : 'Reconnect Slack workspace'}
              </Button>
            )}
          <Button variant="outline" onClick={setAttempt}>
            Check Slack status
          </Button>
        </StatePanel>
      )}
      {state.kind === 'ready' &&
        state.value.canManage &&
        !['disconnected', 'unavailable'].includes(state.value.state) && <SlackGrants workspaceId={workspaceId} />}
    </section>
  );
}

export function SlackAccount({ workspaceId }: { workspaceId: string }) {
  const read = useSlackIntegration(workspaceId);
  if (read.state.kind === 'loading')
    return (
      <StatePanel
        kind="loading"
        title="Checking your Slack access"
        description="Your Slack account and knowledge sources stay unchanged."
      />
    );
  if (read.state.kind === 'error')
    return (
      <StatePanel
        kind="error"
        title="Could not check your Slack access"
        description="Check again before reconnecting your Slack account."
      >
        <Button variant="outline" onClick={() => void read.refresh()}>
          Check my Slack access
        </Button>
      </StatePanel>
    );
  if (read.state.kind === 'unavailable' || read.state.data === 'unavailable')
    return (
      <StatePanel
        kind="unavailable"
        title="Slack access unavailable"
        description="Ask an integration manager for Slack access."
      />
    );
  const value = read.state.data;
  if (value.state !== 'active' && !value.recoveryEventId)
    return (
      <StatePanel
        kind="empty"
        title="Slack is not connected"
        description="Connect Slack above, or ask a workspace admin to connect it."
      />
    );
  return (
    <section className="space-y-3" aria-label="Your Slack account">
      {read.state.error && (
        <p role="alert">Slack status could not refresh. Check your Slack access before reconnecting.</p>
      )}
      {value.recoveryEventId && (
        <Button
          nativeButton={false}
          render={<Link to="/slack/link" search={{ workspaceId, eventId: value.recoveryEventId }} />}
        >
          Reconnect my Slack account
        </Button>
      )}
      {value.state === 'active' && <SlackKnowledgeSources workspaceId={workspaceId} />}
    </section>
  );
}

const recipients = z.object({ memberIds: z.array(z.uuid()), teamIds: z.array(z.uuid()) });
const grantsSchema = z.object({ use: recipients, managers: recipients, expectedVersion: z.string() });
async function slackGrants(workspaceId: string, signal?: AbortSignal, body?: z.infer<typeof grantsSchema>) {
  const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/slack/grants`, {
    method: body ? 'PUT' : 'GET',
    signal: requestSignal(signal),
    cache: 'no-store',
    body,
  });
  if (!response.ok) throw new IntegrationRequestError(response.status);
  return grantsSchema.parse(await readJson(response));
}
function SlackGrants({ workspaceId }: { workspaceId: string }) {
  const read = useFeatureRead({
    key: ['integrations', 'slack', 'grants'],
    load: signal => slackGrants(workspaceId, signal),
  });
  const people = useIntegrationAdministration(workspaceId);
  const [draft, setDraft] = useState<z.infer<typeof grantsSchema> | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [writeError, setWriteError] = useState(false);
  const lock = useRef(false);
  if (read.state.kind === 'loading' || people.state.kind === 'loading')
    return (
      <StatePanel
        kind="loading"
        title="Loading Slack sharing"
        description="Checking current grants and sharing recipients."
      />
    );
  if (read.state.kind !== 'ready' || people.state.kind !== 'ready')
    return (
      <StatePanel
        kind="error"
        title="Could not load Slack sharing"
        description="Reload sharing recipients and grants to continue."
      >
        <Button
          variant="outline"
          onClick={() => {
            void read.refresh();
            void people.refresh();
          }}
        >
          Reload Slack sharing
        </Button>
      </StatePanel>
    );
  const value = draft ?? read.state.data;
  const collaborators = people.state.data;
  const conflict = value.expectedVersion !== read.state.data.expectedVersion;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(read.state.data);
  const refreshing = read.state.refreshing || people.state.refreshing;
  const blocked = conflict
    ? 'Sharing changed. Discard your changes to load the latest permissions.'
    : read.state.error || people.state.error || writeError
      ? 'Reload Slack sharing before saving.'
      : refreshing
        ? 'Wait for sharing to finish loading.'
        : undefined;
  const disabled = saving || !!blocked;
  const reload = async () => {
    await Promise.all([read.refresh(), people.refresh()]);
    setWriteError(false);
  };
  async function save() {
    if (lock.current || disabled) return;
    lock.current = true;
    setSaving(true);
    setMessage(null);
    try {
      setDraft(await slackGrants(workspaceId, undefined, value));
      await read.refresh();
      setMessage('Slack sharing saved.');
    } catch {
      setWriteError(true);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return (
    <section className="space-y-3" aria-label="Slack sharing">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Sharing</h3>
        <p className="text-sm text-muted-foreground">
          Use lets people link their Slack account. Manage lets them reconnect Slack and change sharing. Keep at least
          one manager.
        </p>
      </div>
      <Form disabled={disabled} onSubmit={() => void save()}>
        <div className="space-y-3">
          {collaborators.members.length + collaborators.teams.length === 0 ? (
            <StatePanel
              kind="empty"
              heading="h4"
              title="No sharing recipients"
              description="No people or teams are available to select. Existing permissions stay unchanged."
            />
          ) : (
            <div>
              <div
                className="flex items-center gap-2 border-b border-border pb-2 text-xs text-muted-foreground"
                aria-hidden="true"
              >
                <span className="min-w-0 flex-1">People and teams</span>
                <span className="w-14 shrink-0 text-center">Use</span>
                <span className="w-14 shrink-0 text-center">Manage</span>
              </div>
              <ul className="divide-y divide-border" aria-label="Sharing recipients">
                {(['members', 'teams'] as const).flatMap(group =>
                  collaborators[group].map(person => {
                    const key = group === 'members' ? 'memberIds' : 'teamIds';
                    return (
                      <li key={`${group}/${person.id}`} className="flex items-center gap-2 py-1 text-sm">
                        <div className="min-w-0 flex-1 break-words py-1">
                          <span>{person.name}</span>
                          {group === 'teams' && <span className="ml-2 text-xs text-muted-foreground">Team</span>}
                        </div>
                        {(['use', 'managers'] as const).map(kind => (
                          <div key={kind} className="flex min-h-9 w-14 shrink-0 items-center justify-center">
                            <Label>
                              <Checkbox
                                disabled={disabled}
                                checked={value[kind][key].includes(person.id)}
                                onCheckedChange={checked => {
                                  setMessage(null);
                                  setDraft({
                                    ...value,
                                    [kind]: {
                                      ...value[kind],
                                      [key]: checked
                                        ? [...value[kind][key], person.id]
                                        : value[kind][key].filter(id => id !== person.id),
                                    },
                                  });
                                }}
                              />
                              <span className="sr-only">
                                {kind === 'use' ? 'Use' : 'Manage'} {person.name}
                              </span>
                            </Label>
                          </div>
                        ))}
                      </li>
                    );
                  }),
                )}
              </ul>
            </div>
          )}
          <FormFooter
            dirty={dirty}
            submit={{
              label: 'Save Slack sharing',
              pendingLabel: 'Saving Slack sharing…',
              state: saving ? { kind: 'busy' } : blocked ? { kind: 'blocked', reason: blocked } : { kind: 'ready' },
            }}
            cancel={{
              kind: 'reset',
              label: 'Discard changes',
              onReset: () => {
                setDraft(null);
                setMessage(null);
                void reload();
              },
            }}
            error={
              writeError
                ? 'Sharing could not be confirmed. Your changes are kept. Reload sharing before submitting again.'
                : undefined
            }
          >
            {message && (
              <p role="status" className="text-sm text-muted-foreground">
                {message}
              </p>
            )}
            {(conflict || read.state.error || people.state.error || writeError) && (
              <div>
                <Button variant="outline" disabled={saving || refreshing} onClick={() => void reload()}>
                  Reload Slack sharing
                </Button>
              </div>
            )}
          </FormFooter>
        </div>
      </Form>
    </section>
  );
}
