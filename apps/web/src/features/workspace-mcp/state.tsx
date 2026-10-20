import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ReadFeedback } from '@/components/read-feedback';
import { useMcpApi, useMcpCapabilities } from './queries';
import type { ReadState } from '@/features/tables/request-state';
import { mcpAccessEvent, McpRequestError, type McpApi } from './api';
import type { Capabilities } from './contracts';

export function McpGate({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: (api: McpApi, capabilities: Capabilities) => ReactNode;
}) {
  const api = useMcpApi(workspaceId);
  const denied = useMcpAccessLoss(workspaceId);
  const read = useMcpCapabilities(api);
  if (denied)
    return (
      <StatePanel
        kind="unavailable"
        title="MCP access changed"
        description="Protected MCP content has been removed. Return to Integrations or start a clean-context chat or task."
      />
    );
  return (
    <McpRead state={read.state} refresh={read.refresh} label="MCP availability">
      {(capabilities, blocked) =>
        capabilities.enabled
          ? children(api, {
              ...capabilities,
              integrationsEnabled: capabilities.integrationsEnabled && !blocked,
              dispatchEnabled: capabilities.dispatchEnabled && !blocked,
            })
          : null
      }
    </McpRead>
  );
}

export function useMcpAccessLoss(workspaceId: string) {
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    const clear = (event: Event) => {
      if (event instanceof CustomEvent && event.detail.workspaceId === workspaceId) setDenied(true);
    };
    window.addEventListener(mcpAccessEvent, clear);
    return () => window.removeEventListener(mcpAccessEvent, clear);
  }, [workspaceId]);
  return denied;
}

export function McpRead<T>({
  state,
  refresh,
  label,
  errorDescription,
  children,
}: {
  state: ReadState<T>;
  refresh: () => Promise<void>;
  label: string;
  errorDescription?: string;
  children: (data: T, blocked: boolean) => ReactNode;
}) {
  const retry = (
    <Button variant="outline" disabled={state.kind === 'ready' && state.refreshing} onClick={() => void refresh()}>
      Check {label.toLowerCase()} again
    </Button>
  );
  return (
    <ReadFeedback
      state={state.kind === 'error' && errorDescription ? { ...state, message: errorDescription } : state}
      errorTitle={`${label} could not load`}
      retry={retry}
      loading={
        <div role="status" aria-label={`Loading ${label.toLowerCase()}`} className="space-y-3">
          <Skeleton />
          <Skeleton />
        </div>
      }
      unavailable={() => (
        <StatePanel
          kind="unavailable"
          title={`${label} unavailable`}
          description="Your access changed or this item was removed. Previously loaded content is no longer available."
        />
      )}
      refreshError={message => (
        <div className="space-y-2">
          <Alert variant="destructive">
            <AlertDescription>{errorDescription ?? message}</AlertDescription>
          </Alert>
          {retry}
        </div>
      )}
      refreshing={
        <p role="status" className="sr-only">
          Checking {label.toLowerCase()}…
        </p>
      }
    >
      {data => children(data, state.kind !== 'ready' || !!state.error || state.refreshing)}
    </ReadFeedback>
  );
}

type CommandState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'success' }
  | { kind: 'error'; message: string; fields: Record<string, string>; uncertain: boolean };
export function useMcpCommand() {
  const [state, setState] = useState<CommandState>({ kind: 'idle' });
  const active = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async (work: () => Promise<unknown>, accepted: () => void | Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setState({ kind: 'sending' });
    try {
      await work();
      if (mounted.current) {
        setState({ kind: 'success' });
        await accepted();
      }
    } catch (error) {
      if (mounted.current)
        setState({
          kind: 'error',
          message:
            error instanceof McpRequestError
              ? error.message
              : 'The operation could not be confirmed. Check current status before continuing.',
          fields: error instanceof McpRequestError ? error.fields : {},
          uncertain: !(error instanceof McpRequestError) || error.status >= 500,
        });
    } finally {
      active.current = false;
    }
  }, []);
  return {
    state,
    run,
    busy: state.kind === 'sending',
    blocked: state.kind === 'sending' || (state.kind === 'error' && state.uncertain),
    reset: () => setState({ kind: 'idle' }),
  };
}
export function McpCommandFeedback({
  command,
  check,
}: {
  command: ReturnType<typeof useMcpCommand>;
  check: () => Promise<void>;
}) {
  return command.state.kind === 'error' ? (
    <div className="space-y-2">
      <Alert variant="destructive">
        <AlertDescription>{command.state.message}</AlertDescription>
      </Alert>
      <Button variant="outline" disabled={command.busy} onClick={() => void check()}>
        Check current status
      </Button>
    </div>
  ) : command.state.kind === 'success' ? (
    <p role="status" className="text-sm">
      Change confirmed by the server.
    </p>
  ) : null;
}
