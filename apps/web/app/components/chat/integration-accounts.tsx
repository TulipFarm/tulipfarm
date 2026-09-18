import type { McpAccountSummary, McpIntegrationDefinition } from "@tulipfarm/schema";
import { useEffect, useState } from "react";
import { accountLabel, McpAccountSelection } from "~/components/integrations/mcp-account-selection";
import { McpCapabilities } from "~/components/integrations/mcp-capabilities";
import { McpContent } from "~/components/integrations/mcp-content";
import { McpError, mcpError } from "~/components/integrations/mcp-form";
import { Button } from "~/components/ui/button";
import { getMcpChatAccount, listMcpAccounts, selectMcpChatAccount } from "~/lib/mcp-accounts";
import { listMcpIntegrations } from "~/lib/mcp-integrations";
import { useIsAdmin } from "~/lib/use-session-user";

type AccountState = {
  key: string;
  label: string;
  accounts: McpAccountSummary[];
  selected: McpAccountSummary | null;
  definition: McpIntegrationDefinition;
  error?: unknown;
};

async function loadAccount(
  chatId: string,
  key: string,
  label: string,
  definition: McpIntegrationDefinition
): Promise<AccountState> {
  const accounts = await listMcpAccounts(key);
  try {
    return { key, label, accounts, definition, selected: await getMcpChatAccount(chatId, key) };
  } catch (error) {
    return { key, label, accounts, definition, selected: null, error };
  }
}

export function ChatIntegrationAccounts({
  chatId,
  disabled,
}: {
  chatId?: string;
  disabled: boolean;
}) {
  const isAdmin = useIsAdmin();
  const [rows, setRows] = useState<AccountState[]>([]);
  const [error, setError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads the same Chat account bindings.
  useEffect(() => {
    if (!chatId) {
      setRows([]);
      return;
    }
    let live = true;
    setRows([]);
    setError(undefined);
    setLoading(true);
    listMcpIntegrations()
      .then(async (servers) =>
        Promise.all(
          servers
            .filter((entry) => entry.enabled || isAdmin)
            .map(async (definition) => {
              const { server } = definition;
              try {
                return await loadAccount(chatId, server.id, server.label, definition);
              } catch (cause) {
                return {
                  key: server.id,
                  label: server.label,
                  accounts: [],
                  definition,
                  selected: null,
                  error: cause,
                };
              }
            })
        )
      )
      .then((next) => {
        if (live) setRows(next);
      })
      .catch((cause) => {
        if (live) setError(cause);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [chatId, attempt, isAdmin]);

  if (!chatId || (!loading && !error && rows.length === 0)) return null;
  return (
    <aside
      aria-label="Chat Integration accounts"
      className="shrink-0 border-b border-border px-4 py-2 sm:px-6"
    >
      {loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading Integration accounts...
        </p>
      ) : null}
      <McpError error={error} />
      {error ? (
        <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          Retry Integration accounts
        </Button>
      ) : null}
      {rows.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Integration accounts</span>
            {rows.map((row) => (
              <span key={row.key} className="ml-2 inline-block break-all">
                {row.label}:{" "}
                {row.selected
                  ? accountLabel(row.selected)
                  : row.error
                    ? "Action required"
                    : "Selection required"}
                {!row.definition.enabled ? " · Server disabled" : ""}
              </span>
            ))}
          </summary>
          <div className="mt-3 max-h-72 space-y-4 overflow-y-auto">
            <p className="text-xs text-muted-foreground">
              Accounts stay bound to this Chat. Agents cannot switch identity. Personal accounts
              cannot be used in shared channels; linked users are required for channel requests.
            </p>
            {rows.map((row) => (
              <div key={row.key} className="space-y-2">
                {row.error ? (
                  <p role="alert" className="text-xs text-destructive">
                    {mcpError(row.error)}
                  </p>
                ) : null}
                <McpAccountSelection
                  integrationKey={row.key}
                  integrationLabel={row.label}
                  accounts={row.accounts}
                  selection={row.selected}
                  disabled={disabled}
                  onSelect={async (input) => {
                    await selectMcpChatAccount(chatId, row.key, input);
                    const refreshed = await loadAccount(chatId, row.key, row.label, row.definition);
                    if (refreshed.error) throw refreshed.error;
                    setRows((previous) =>
                      previous.map((entry) => (entry.key === row.key ? refreshed : entry))
                    );
                  }}
                />
                {row.selected &&
                  !row.error &&
                  row.definition.enabled &&
                  (row.definition.reviewed.resources.length > 0 ||
                    row.definition.reviewed.prompts.length > 0) && (
                    <details>
                      <summary className="cursor-pointer text-xs font-medium">
                        Resources and prompts for this Chat account
                      </summary>
                      <div className="mt-3">
                        <McpContent
                          key={`${row.selected.id}:${row.selected.revision}`}
                          serverId={row.key}
                          capabilities={row.definition.reviewed}
                          enabled
                          disabled={disabled}
                          context={{ chatId }}
                        />
                      </div>
                    </details>
                  )}
                {isAdmin && row.selected && !row.error && (
                  <details>
                    <summary className="cursor-pointer text-xs font-medium">
                      Review capabilities with this Chat account
                    </summary>
                    <fieldset disabled={disabled} className="mt-3">
                      <McpCapabilities
                        key={`${row.selected.id}:${row.selected.revision}:${JSON.stringify(row.definition.reviewed)}`}
                        definition={row.definition}
                        isAdmin
                        context={{ chatId }}
                        onChanged={() => setAttempt((value) => value + 1)}
                      />
                    </fieldset>
                  </details>
                )}
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setAttempt((value) => value + 1)}
            >
              Refresh account access
            </Button>
          </div>
        </details>
      )}
    </aside>
  );
}
