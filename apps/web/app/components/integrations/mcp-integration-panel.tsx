import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { McpError } from "./mcp-form";
import { loadMcpIntegrationData, type McpIntegrationData } from "./mcp-integration-data";
import { McpServerDetail } from "./mcp-server-detail";

interface McpIntegrationPanelProps {
  serverId: string;
  onChanged: () => void;
  onRemoved?: () => void;
  embedded?: boolean;
  onDone?: () => void;
}

interface PanelState {
  loading: boolean;
  data?: McpIntegrationData;
  error?: unknown;
}

export function McpIntegrationPanel(props: McpIntegrationPanelProps) {
  return <IntegrationPanelContent key={props.serverId} {...props} />;
}

function IntegrationPanelContent({
  serverId,
  onChanged,
  onRemoved,
  embedded = true,
  onDone,
}: McpIntegrationPanelProps) {
  const [state, setState] = useState<PanelState>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const [removed, setRemoved] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry and persisted changes must load fresh account metadata.
  useEffect(() => {
    if (removed) return;
    let live = true;
    setState((previous) => ({ loading: true, data: previous.data }));
    loadMcpIntegrationData(serverId)
      .then((data) => {
        if (live) setState({ loading: false, data });
      })
      .catch((error: unknown) => {
        if (live) setState({ loading: false, error });
      });
    return () => {
      live = false;
    };
  }, [serverId, attempt, removed]);

  if (removed)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Integration removed.
      </p>
    );

  return (
    <div aria-busy={state.loading} className="space-y-4">
      {state.loading && (
        <p role="status" className="text-sm text-muted-foreground">
          {state.data ? "Refreshing integration..." : "Loading integration..."}
        </p>
      )}
      {!state.loading && !state.data && (
        <McpError error={state.error ?? new Error("Integration could not be loaded.")} />
      )}
      {!state.loading && !state.data && (
        <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          Retry integration
        </Button>
      )}
      {state.data && (
        <McpServerDetail
          embedded={embedded}
          onDone={onDone}
          definition={state.data.definition}
          accounts={state.data.accounts.items}
          accountsError={state.data.accounts.error ?? undefined}
          accountConfiguration={state.data.configuration.value ?? undefined}
          configurationError={state.data.configuration.error ?? undefined}
          eligibility={state.data.eligibility.value ?? undefined}
          eligibilityError={state.data.eligibility.error ?? undefined}
          refreshing={state.loading}
          onChanged={() => {
            setAttempt((value) => value + 1);
            onChanged();
          }}
          onRemoved={() => {
            setRemoved(true);
            onChanged();
            onRemoved?.();
          }}
        />
      )}
    </div>
  );
}
