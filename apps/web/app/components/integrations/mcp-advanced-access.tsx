import type { McpAccountSummary, McpIntegrationDefinition } from "@tulipfarm/schema";
import { useEffect, useState } from "react";
import { Link } from "~/components/ui/link";
import type { McpAccountConfiguration } from "~/lib/mcp-accounts";
import { IntegrationChoice } from "./integration-choice";
import { accountLabel } from "./mcp-account-selection";
import { McpCapabilities } from "./mcp-capabilities";
import { McpContent } from "./mcp-content";
import { McpField } from "./mcp-form";

export function McpAdvancedAccess({
  definition,
  accounts,
  configuration,
  onChanged,
  canConfigure,
}: {
  definition: McpIntegrationDefinition;
  accounts: McpAccountSummary[];
  configuration: McpAccountConfiguration;
  onChanged: () => void;
  canConfigure: boolean;
}) {
  const isAdmin = canConfigure;
  const [selectedId, setSelectedId] = useState("");
  const authless = configuration.authentication === "none";
  const available = accounts.filter(
    (account) =>
      account.status === "active" &&
      (!configuration.definitionDigest ||
        account.definitionDigest === configuration.definitionDigest) &&
      (!account.expiresAt || Date.parse(account.expiresAt) > Date.now()) &&
      (account.owner.scope === "personal" || isAdmin)
  );
  const selected = available.find((account) => account.id === selectedId);
  const solePersonalId =
    available.length === 1 && available[0]?.owner.scope === "personal"
      ? available[0].id
      : undefined;
  useEffect(() => {
    if (!selectedId && solePersonalId) setSelectedId(solePersonalId);
  }, [selectedId, solePersonalId]);
  const context = selected ? { accountId: selected.id } : undefined;
  const contextKey = selected
    ? `${selected.id}:${selected.revision}:${selected.definitionDigest}`
    : "unselected";

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-medium">Allowed Tools and content</h4>
      <p className="text-xs text-muted-foreground">
        {isAdmin
          ? "Optional: limit access or change action approvals. New or changed capabilities stay unavailable until you approve them here."
          : "An admin manages which Tools and content this integration allows."}
      </p>
      {selected && (
        <p className="text-xs text-muted-foreground">
          {accountLabel(selected, available)} · for this preview only
        </p>
      )}
      {!authless &&
        (!solePersonalId || selected?.id !== solePersonalId) &&
        available.length > 0 && (
          <McpField label="Account to review">
            <IntegrationChoice
              label="Account to review"
              value={selected?.id ?? ""}
              options={available.map((account) => ({
                value: account.id,
                label: accountLabel(account, available),
              }))}
              onChange={setSelectedId}
            />
          </McpField>
        )}
      {selectedId && !selected && (
        <p role="alert" className="text-xs text-destructive">
          The selected account is no longer available. Reconnect it or explicitly choose another.
        </p>
      )}
      {!authless && available.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Connect an account to check its available access. Saved restrictions are shown below.
        </p>
      )}
      {selected?.owner.scope === "shared" && (
        <p className="text-xs text-muted-foreground">
          This shared account is selected only for admin access review. It does not authorize
          content previews or shared Chat use.
        </p>
      )}
      <fieldset disabled={!authless && !selected}>
        <McpCapabilities
          key={`${JSON.stringify(definition)}:${contextKey}`}
          definition={definition}
          isAdmin={isAdmin}
          context={context}
          onChanged={onChanged}
        />
      </fieldset>
      {definition.enabled && (
        <details className="space-y-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Preview approved content
          </summary>
          {selected?.owner.scope === "shared" && (
            <p className="text-xs text-muted-foreground">
              Choose a personal account to preview here. For shared content, confirm the exact
              shared account in a private{" "}
              <Link to="/" className="underline">
                Chat
              </Link>
              .
            </p>
          )}
          <McpContent
            key={`${JSON.stringify(definition)}:${contextKey}`}
            serverId={definition.server.id}
            capabilities={definition.reviewed}
            enabled={definition.enabled}
            disabled={!authless && selected?.owner.scope !== "personal"}
            context={context}
          />
        </details>
      )}
    </div>
  );
}
