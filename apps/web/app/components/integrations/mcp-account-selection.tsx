import type { McpAccountSelectionRequest, McpAccountSummary } from "@tulipfarm/schema";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { IntegrationChoice } from "./integration-choice";
import { McpError } from "./mcp-form";

export function accountName(
  account: McpAccountSummary,
  accounts: readonly McpAccountSummary[] = []
): string {
  const duplicates = accounts.filter(
    (other) =>
      other.id !== account.id &&
      other.label === account.label &&
      other.owner.scope === account.owner.scope
  );
  if (duplicates.length === 0) return account.label;
  const added = new Date(account.createdAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  const sameTime = duplicates.some(
    (other) => Date.parse(other.createdAt) === Date.parse(account.createdAt)
  );
  return `${account.label} · Added ${added}${sameTime ? ` · ${account.id}` : ""}`;
}

export function accountLabel(
  account: McpAccountSummary,
  accounts: readonly McpAccountSummary[] = []
): string {
  return `${accountName(account, accounts)} · ${account.owner.scope === "personal" ? "Personal" : "Shared"}`;
}

export function McpAccountSelection({
  integrationKey,
  integrationLabel,
  accounts,
  selection,
  disabled,
  onSelect,
}: {
  integrationKey: string;
  integrationLabel: string;
  accounts: McpAccountSummary[];
  selection: McpAccountSummary | null;
  disabled?: boolean;
  onSelect: (input: McpAccountSelectionRequest) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const current = selection;
  const candidate = accounts.find((account) => account.id === draft);
  const choices = accounts.filter(
    (account) =>
      account.status === "active" &&
      (!account.expiresAt || Date.parse(account.expiresAt) > Date.now())
  );
  const sharedConfirmation = candidate?.owner.scope === "shared";

  async function choose(confirmShared: boolean) {
    if (!candidate) return;
    setPending(true);
    setError(undefined);
    try {
      await onSelect({ accountId: candidate.id, confirmShared });
      setDraft(undefined);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium">{integrationLabel}</p>
        <Link
          to={`/integrations/${encodeURIComponent(integrationKey)}${current ? `?account=${encodeURIComponent(current.id)}` : ""}`}
          className="text-xs text-brand hover:underline"
        >
          Manage accounts
        </Link>
      </div>
      <p className="break-words text-xs text-muted-foreground">
        {current
          ? `Selected: ${accountLabel(current, accounts)}`
          : "No account selected for this Chat."}
      </p>
      {current &&
        (current.status !== "active" ||
          (current.expiresAt && Date.parse(current.expiresAt) <= Date.now())) && (
          <p role="alert" className="text-xs text-destructive">
            The selected account needs attention. Integration actions stop; a shared account will
            not be substituted.
          </p>
        )}
      <McpError error={error} />
      {choices.length > 0 ? (
        <div className="space-y-2">
          <IntegrationChoice
            label={`${integrationLabel} account`}
            value={draft ?? selection?.id ?? ""}
            options={choices.map((account) => ({
              value: account.id,
              label: accountLabel(account, accounts),
            }))}
            disabled={disabled || pending}
            onChange={(id) => {
              setDraft(id);
              setError(undefined);
            }}
          />
          {candidate && (
            <div className="space-y-2">
              {sharedConfirmation && (
                <p className="text-xs text-muted-foreground">
                  Use shared account <strong>{candidate.label}</strong> for {integrationLabel} in
                  this Chat? Its access is shared, not your personal identity. This consent does not
                  approve individual actions or grant Routine access.
                </p>
              )}
              {candidate.owner.scope === "personal" && (
                <p className="text-xs text-muted-foreground">
                  Personal account content stays private. This account cannot be used in shared
                  channels.
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={disabled || pending}
                  onClick={() => void choose(candidate.owner.scope === "shared")}
                >
                  {pending
                    ? "Saving..."
                    : sharedConfirmation
                      ? "Confirm shared account"
                      : "Use this account"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setDraft(undefined)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No authorized active account is available. Connect or repair an account in Integrations.
        </p>
      )}
    </div>
  );
}
