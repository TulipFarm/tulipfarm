import { useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { Disclosure } from '@/components/disclosure';
import { UnsavedChanges } from '@/features/tables/feedback';
import { useMcpIntegration } from './queries';
import type { McpApi } from './api';
import type { Capabilities, IntegrationDetail } from './contracts';
import { McpRead, McpCommandFeedback, useMcpCommand } from './state';
import { McpSetup } from './setup';
import { McpActions } from './actions';

const pending = (detail: IntegrationDetail) =>
  ['oauth-pending', 'discovering', 'setup'].includes(detail.integration.status);
export function McpIntegrationDetail({
  api,
  capabilities,
  id,
  close,
  reauthorize = false,
}: {
  api: McpApi;
  capabilities: Capabilities;
  id: string;
  close: () => void;
  reauthorize?: boolean;
}) {
  const read = useMcpIntegration(api, id);
  const [reconnect, setReconnect] = useState(reauthorize);
  return (
    <section aria-label="MCP integration details" className="space-y-4 border-t pt-6">
      <Button variant="ghost" onClick={close}>
        Close integration details
      </Button>
      <McpRead state={read.state} refresh={read.refresh} label="MCP integration details">
        {(detail, blocked) => (
          <>
            <h3 className="break-all text-lg font-medium">{detail.integration.name}</h3>
            <p className="break-all text-sm">{detail.integration.endpoint}</p>
            <p>
              {detail.integration.ownership === 'personal'
                ? 'Private to you, including from workspace admins.'
                : 'Workspace-managed. Use requires a current explicit grant.'}
            </p>
            <p role="status">
              Server status: {detail.integration.status}. {detail.integration.statusReason}
            </p>
            {detail.integration.barrier && (
              <Alert>
                <AlertDescription>
                  This entire integration is paused by an unknown outcome, including for other shared users. Check the
                  external service and reconcile the action below. Disabling, reconnecting, or deleting does not clear
                  this barrier.
                </AlertDescription>
              </Alert>
            )}
            {pending(detail) && (
              <p>Setup continues on the server if you leave. No new tools can run before verification and review.</p>
            )}
            {read.delayed && (
              <p role="status">
                Automatic checks stopped after a minute. Check status when provider setup is complete.
              </p>
            )}
            {(pending(detail) ||
              read.delayed ||
              detail.integration.status === 'error' ||
              detail.integration.status === 'registration-required') && (
              <Button variant="outline" disabled={blocked} onClick={() => void read.refresh()}>
                Check integration status
              </Button>
            )}
            {detail.integration.canManage && (
              <>
                <IntegrationPolicy api={api} detail={detail} blocked={blocked} refresh={read.refresh} close={close} />
                <Button
                  variant="outline"
                  disabled={blocked || !capabilities.integrationsEnabled}
                  onClick={() => setReconnect(!reconnect)}
                >
                  {reconnect ? 'Hide reconnect form' : 'Reconnect or replace credentials'}
                </Button>
                {reconnect && (
                  <McpSetup
                    api={api}
                    capabilities={capabilities}
                    integration={detail.integration}
                    close={() => setReconnect(false)}
                    saved={() => {
                      setReconnect(false);
                      void read.refresh();
                    }}
                  />
                )}
              </>
            )}
            {!detail.integration.canManage && (
              <p>
                Only the personal owner or an appointed integration manager can review tools and change this
                integration.
              </p>
            )}
            <McpActions api={api} capabilities={capabilities} kind="integration" originId={id} />
          </>
        )}
      </McpRead>
    </section>
  );
}

function IntegrationPolicy({
  api,
  detail,
  blocked,
  refresh,
  close,
}: {
  api: McpApi;
  detail: IntegrationDetail;
  blocked: boolean;
  refresh: () => Promise<void>;
  close: () => void;
}) {
  const [draft, setDraft] = useState<{
    version: number;
    tools: IntegrationDetail['tools'];
    grants: IntegrationDetail['grants'];
    managers: IntegrationDetail['managers'];
  } | null>(null);
  const [confirm, setConfirm] = useState<'disconnect' | 'delete' | null>(null);
  const command = useMcpCommand();
  const tools = draft?.tools ?? detail.tools;
  const grants = draft?.grants ?? detail.grants;
  const managers = draft?.managers ?? detail.managers;
  const conflict = draft !== null && draft.version !== detail.integration.version;
  const locked = blocked || command.blocked || conflict;
  const edit = () =>
    draft ?? {
      version: detail.integration.version,
      tools: detail.tools,
      grants: detail.grants,
      managers: detail.managers,
    };
  const updateTool = (name: string, enabled: boolean, standingException: boolean) =>
    setDraft({
      ...edit(),
      tools: tools.map(tool =>
        tool.name === name ? { ...tool, enabled, standingException: enabled && standingException } : tool,
      ),
    });
  const changed = async () => {
    setDraft(null);
    await refresh();
  };
  const input = () => ({ requestId: crypto.randomUUID(), expectedVersion: detail.integration.version });
  return (
    <div className="space-y-5">
      <UnsavedChanges dirty={!!draft || command.busy} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={
            locked || ['disconnected', 'oauth-pending', 'registration-required'].includes(detail.integration.status)
          }
          aria-busy={command.busy}
          onClick={() =>
            void command.run(() => api.integrationCommand(detail.integration.id, 'discover', input()), changed)
          }
        >
          Discover current tools
        </Button>
        <Button
          variant="outline"
          disabled={locked || detail.integration.status === 'disconnected'}
          onClick={() =>
            void command.run(
              () =>
                api.lifecycle(detail.integration.id, {
                  ...input(),
                  operation: detail.integration.status === 'disabled' ? 'enable' : 'disable',
                }),
              changed,
            )
          }
        >
          {detail.integration.status === 'disabled' ? 'Enable integration' : 'Disable integration'}
        </Button>
        <Button variant="outline" disabled={locked} onClick={() => setConfirm('disconnect')}>
          Disconnect integration
        </Button>
        <Button variant="destructive" disabled={locked} onClick={() => setConfirm('delete')}>
          Delete integration
        </Button>
      </div>
      {confirm && (
        <Alert>
          <AlertDescription>
            <div className="space-y-3">
              <p>
                {confirm === 'delete'
                  ? 'Delete this integration? Usable credentials are removed. Bounded tombstones and unresolved action evidence remain.'
                  : 'Disconnect this integration? Credentials become unusable and current selections and approvals are invalidated.'}{' '}
                Already dispatched work cannot be undone. Unknown outcomes remain paused.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="destructive"
                  disabled={locked}
                  onClick={() =>
                    void command.run(
                      () => api.lifecycle(detail.integration.id, { ...input(), operation: confirm }),
                      async () => {
                        if (confirm === 'delete') close();
                        else {
                          setConfirm(null);
                          await changed();
                        }
                      },
                    )
                  }
                >
                  Confirm {confirm}
                </Button>
                <Button variant="ghost" onClick={() => setConfirm(null)}>
                  Keep integration
                </Button>
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}
      <section aria-label="MCP tool review" className="space-y-3">
        <h4 className="font-medium">Review tools</h4>
        <p>
          Descriptions and schemas are untrusted server content. New tools start disabled. A changed description or
          contract pauses that tool and invalidates its pending approvals and standing exception. Unchanged tools stay
          available.
        </p>
        {tools.length === 0 && (
          <p>No tools were discovered. Check server compatibility and authentication, then discover tools again.</p>
        )}
        {tools.length > 0 && !tools.some(tool => tool.compatibility === 'compatible') && (
          <Alert>
            <AlertDescription>
              No compatible tools were discovered. Review the reasons below or use a compatible server.
            </AlertDescription>
          </Alert>
        )}
        <ul className="divide-y">
          {tools.map(tool => (
            <li key={`${tool.name}/${tool.revision}`} className="min-w-0 space-y-3 py-4">
              <div className="space-y-2">
                <h5 className="break-all font-medium">{tool.name}</h5>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={tool.review === 'changed' ? 'warning' : 'secondary'}>
                    {tool.review === 'changed'
                      ? 'Changed, paused until reviewed'
                      : tool.review === 'new'
                        ? 'New, disabled until reviewed'
                        : 'Reviewed'}
                  </Badge>
                  {tool.compatibility === 'unsupported' && <Badge variant="warning">Unsupported contract</Badge>}
                </div>
              </div>
              <p className="whitespace-pre-wrap break-words">{tool.description}</p>
              <p className="break-all text-sm text-muted-foreground">
                Current revision {tool.revision}
                {tool.previousRevision ? ` · Previous revision ${tool.previousRevision}` : ''}
              </p>
              {tool.reason && <p>{tool.reason}</p>}
              <Disclosure title={`Inspect contract for ${tool.name}`}>
                <div className="space-y-2">
                  <h6 className="font-medium">Input schema</h6>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(tool.inputSchema, null, 2)}
                  </pre>
                  <h6 className="font-medium">Output schema</h6>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
                    {tool.outputSchema === null ? 'Not declared' : JSON.stringify(tool.outputSchema, null, 2)}
                  </pre>
                </div>
              </Disclosure>
              <Label>
                <Checkbox
                  disabled={locked || tool.compatibility !== 'compatible'}
                  checked={tool.enabled}
                  onCheckedChange={checked => updateTool(tool.name, checked === true, tool.standingException)}
                />
                Enable reviewed tool {tool.name}
              </Label>
              <Label>
                <Checkbox
                  disabled={locked || !tool.enabled || tool.compatibility !== 'compatible'}
                  checked={tool.standingException}
                  onCheckedChange={checked => updateTool(tool.name, tool.enabled, checked === true)}
                />
                Standing exception for {tool.name}
              </Label>
            </li>
          ))}
        </ul>
        <Alert>
          <AlertDescription>
            A standing exception permits this exact reviewed tool revision without repeated tool approval. It is not
            proof of no external effects. Private messages, task instructions, and other protected inputs still require
            review of the exact outbound arguments. Selecting an integration is not disclosure consent.
          </AlertDescription>
        </Alert>
        <Button
          disabled={locked || !draft}
          aria-busy={command.busy}
          onClick={() =>
            void command.run(
              () =>
                api.integrationCommand(detail.integration.id, 'tools', {
                  ...input(),
                  tools: tools.map(({ name, revision, enabled, standingException }) => ({
                    name,
                    revision,
                    enabled,
                    standingException,
                  })),
                }),
              changed,
            )
          }
        >
          Save reviewed tools
        </Button>
      </section>
      <section aria-label="Account-independent server identity" className="space-y-3">
        <h4 className="font-medium">Use in saved agents</h4>
        {detail.descriptor.kind === 'chat-only' ? (
          <p>Chat only. {detail.descriptor.reason}</p>
        ) : (
          <>
            <p className="break-all">
              {detail.descriptor.label} · {detail.descriptor.identity}
            </p>
            <p>
              This account-independent identity and the selected tool revisions may be visible in shared agent
              definitions. Your private account and credentials are never included. A server name alone cannot authorize
              endpoint substitutions.
            </p>
            {detail.descriptor.kind === 'reviewable' ? (
              <Button
                variant="outline"
                disabled={locked}
                onClick={() =>
                  void command.run(
                    () =>
                      api.integrationCommand(detail.integration.id, 'descriptor', {
                        ...input(),
                        serverIdentity: detail.descriptor.kind !== 'chat-only' ? detail.descriptor.id : '',
                      }),
                    changed,
                  )
                }
              >
                Approve account-independent descriptor
              </Button>
            ) : (
              <Badge variant="success">Descriptor approved</Badge>
            )}
          </>
        )}
      </section>
      {detail.integration.ownership === 'shared' && (
        <section aria-label="MCP shared grants" className="space-y-3">
          <h4 className="font-medium">Shared integration grants</h4>
          <p>
            Select use and management separately. Managers can change credentials, tools, and sharing. Keep at least one
            current manager. Removing and rejoining does not restore an old grant.
          </p>
          {!detail.grantOptions.length && <p>No eligible members or teams are available.</p>}
          {detail.grantOptions.map(option => (
            <div key={`${option.kind}/${option.id}`} className="space-y-2">
              <Label>
                <Checkbox
                  disabled={locked}
                  checked={grants.some(grant => grant.kind === option.kind && grant.id === option.id)}
                  onCheckedChange={checked =>
                    setDraft({
                      ...edit(),
                      grants: checked
                        ? [
                            ...grants.filter(grant => grant.kind !== option.kind || grant.id !== option.id),
                            { kind: option.kind, id: option.id },
                          ]
                        : grants.filter(grant => grant.kind !== option.kind || grant.id !== option.id),
                    })
                  }
                />
                {option.label} ({option.kind})
              </Label>
              <Label>
                <Checkbox
                  disabled={locked}
                  checked={managers.some(grant => grant.kind === option.kind && grant.id === option.id)}
                  onCheckedChange={checked =>
                    setDraft({
                      ...edit(),
                      managers: checked
                        ? [
                            ...managers.filter(grant => grant.kind !== option.kind || grant.id !== option.id),
                            { kind: option.kind, id: option.id },
                          ]
                        : managers.filter(grant => grant.kind !== option.kind || grant.id !== option.id),
                    })
                  }
                />
                Allow {option.label} to manage and share
              </Label>
            </div>
          ))}
          {!grants.length && <p>No one is granted shared use.</p>}
          <Button
            disabled={locked || !draft || !managers.length}
            onClick={() =>
              void command.run(
                () => api.integrationCommand(detail.integration.id, 'grants', { ...input(), grants, managers }),
                changed,
              )
            }
          >
            Save shared grants
          </Button>
        </section>
      )}
      {conflict && (
        <Alert>
          <AlertDescription>
            Your edits are retained, but the integration changed. Review the current integration before editing again.
            <Button
              variant="outline"
              onClick={() => {
                setDraft(null);
                command.reset();
              }}
            >
              Discard edits and use current review
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <McpCommandFeedback
        command={command}
        check={async () => {
          await refresh();
          command.reset();
        }}
      />
    </div>
  );
}
