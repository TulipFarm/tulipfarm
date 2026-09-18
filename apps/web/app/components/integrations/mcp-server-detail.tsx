import type { McpAccountSummary, McpIntegrationDefinition } from "@tulipfarm/schema";
import { useState } from "react";
import { StatusBadge } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import type { McpAccountConfiguration } from "~/lib/mcp-accounts";
import { removeMcpIntegration } from "~/lib/mcp-integrations";
import { useIsAdmin } from "~/lib/use-session-user";
import { IntegrationChoice } from "./integration-choice";
import { McpAccountForm } from "./mcp-account-form";
import { McpAccountRow } from "./mcp-account-row";
import { accountLabel } from "./mcp-account-selection";
import { McpCapabilities } from "./mcp-capabilities";
import { McpContent } from "./mcp-content";
import { McpError, McpField, McpSection } from "./mcp-form";
import { McpServerForm } from "./mcp-server-form";

export function McpServerDetail({
  definition,
  accounts,
  accountsError,
  callbackStatus,
  accountConfiguration,
  configurationError,
  onChanged,
  onRemoved,
}: {
  definition: McpIntegrationDefinition;
  accounts: McpAccountSummary[];
  accountsError?: string;
  callbackStatus?: string;
  accountConfiguration?: McpAccountConfiguration;
  configurationError?: string;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const isAdmin = useIsAdmin();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [selectedId, setSelectedId] = useState("");
  const availableAccounts = accounts.filter(
    (account) =>
      account.status === "active" &&
      (!account.expiresAt || Date.parse(account.expiresAt) > Date.now()) &&
      (account.owner.scope === "personal" || isAdmin)
  );
  const selectedAccount = availableAccounts.find((account) => account.id === selectedId);
  const accountContext = selectedAccount ? { accountId: selectedAccount.id } : undefined;
  const accountKey = selectedAccount
    ? `${selectedAccount.id}:${selectedAccount.revision}:${selectedAccount.definitionDigest}`
    : "unselected";
  return (
    <div className="max-w-3xl space-y-6">
      <Link to="/integrations" className="text-sm text-brand hover:underline">
        Back to Integrations
      </Link>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{definition.server.label}</h2>
          <p className="text-xs text-muted-foreground">
            <code>{definition.server.id}</code> · MCP server
          </p>
        </div>
        <StatusBadge
          label={definition.enabled ? "Enabled" : "Disabled"}
          tone={definition.enabled ? "success" : "neutral"}
        />
      </header>
      <McpError error={error} />
      {callbackStatus && (
        <p role="status" className="text-sm text-muted-foreground">
          {callbackStatus}
        </p>
      )}
      <McpSection title="Server">
        {editing ? (
          <McpServerForm
            initial={definition}
            onSaved={() => {
              setEditing(false);
              onChanged();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="space-y-3">
            <p className="break-all text-sm text-muted-foreground">
              {definition.server.transport.type === "streamable-http"
                ? definition.server.transport.url
                : `${definition.server.transport.image} · ${definition.server.transport.command}`}
            </p>
            {definition.server.transport.type === "stdio" && (
              <p className="text-xs text-muted-foreground">
                Production requires operator-configured Kata VM isolation on supported Linux/KVM.
                There is no ordinary-container fallback. A missing or unsupported isolated runtime
                refuses execution.
              </p>
            )}
            {isAdmin && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                Edit server
              </Button>
            )}
          </div>
        )}
      </McpSection>
      <McpSection title="Accounts">
        {accountsError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {accountsError}
            </p>
            <Button variant="outline" onClick={onChanged}>
              Retry accounts
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {accounts.map((account) => (
              <McpAccountRow
                key={`${account.id}:${account.revision}`}
                account={account}
                requiredSlots={accountConfiguration?.requiredSlots}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
        {!accountsError && accounts.length === 0 && (
          <p className="text-sm text-muted-foreground">No authorized accounts are connected.</p>
        )}
        {accountConfiguration ? (
          <McpAccountForm
            key={JSON.stringify(accountConfiguration)}
            integrationKey={definition.server.id}
            {...accountConfiguration}
            onChanged={onChanged}
          />
        ) : (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {configurationError ??
                "Account setup is not available. An admin must finish this server's authentication settings."}
            </p>
            <p className="text-xs text-muted-foreground">
              Credential fields only appear after the server provides its verified account setup. Do
              not share tokens or client secrets in Chat.
            </p>
            <Button variant="outline" onClick={onChanged}>
              Reload account setup
            </Button>
          </div>
        )}
      </McpSection>
      <McpSection title="Account for this page">
        <p className="text-xs text-muted-foreground">
          Choose an exact account before discovery or previewing content. This choice does not
          change the account selected in any{" "}
          <Link to="/" className="underline">
            Chat
          </Link>
          .
        </p>
        {availableAccounts.length > 0 ? (
          <McpField label="Account">
            <IntegrationChoice
              label="Setup account"
              value={selectedAccount?.id ?? ""}
              options={availableAccounts.map((account) => ({
                value: account.id,
                label: accountLabel(account),
              }))}
              onChange={setSelectedId}
            />
          </McpField>
        ) : (
          <p className="text-xs text-muted-foreground">
            Connect or repair an account before continuing.
          </p>
        )}
        {selectedId && !selectedAccount && (
          <p role="alert" className="text-xs text-destructive">
            The selected account is no longer available. Repair it or explicitly choose another.
          </p>
        )}
        {selectedAccount?.owner.scope === "shared" && (
          <p className="text-xs text-muted-foreground">
            This shared account is selected only for admin discovery and capability review. It does
            not authorize content previews or shared Chat use.
          </p>
        )}
      </McpSection>
      <McpSection title="Approved capabilities">
        <fieldset disabled={!selectedAccount}>
          <McpCapabilities
            key={`${JSON.stringify(definition)}:${accountKey}`}
            definition={definition}
            isAdmin={isAdmin}
            context={accountContext}
            onChanged={onChanged}
          />
        </fieldset>
      </McpSection>
      <McpSection title="Resources and prompts">
        {selectedAccount?.owner.scope === "shared" && (
          <p className="text-xs text-muted-foreground">
            This page previews only personal accounts. To use shared content, confirm the exact
            shared account in a private{" "}
            <Link to="/" className="underline">
              Chat
            </Link>
            .
          </p>
        )}
        <McpContent
          key={`${JSON.stringify(definition)}:${accountKey}`}
          serverId={definition.server.id}
          capabilities={definition.reviewed}
          enabled={definition.enabled}
          disabled={selectedAccount?.owner.scope !== "personal"}
          context={accountContext}
        />
      </McpSection>
      {isAdmin && (
        <McpSection title="Remove server">
          <p className="text-xs text-muted-foreground">
            Removal revokes its published capabilities. Connected accounts and synced content must
            no longer be usable.
          </p>
          {confirming ? (
            <div className="flex gap-2">
              <Button
                variant="destructive"
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  setError(undefined);
                  try {
                    await removeMcpIntegration(definition.server.id);
                    onRemoved();
                  } catch (cause) {
                    setError(cause);
                  } finally {
                    setPending(false);
                  }
                }}
              >
                {pending ? "Removing..." : "Confirm remove server"}
              </Button>
              <Button variant="outline" disabled={pending} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => setConfirming(true)}>
              Remove server
            </Button>
          )}
        </McpSection>
      )}
    </div>
  );
}
