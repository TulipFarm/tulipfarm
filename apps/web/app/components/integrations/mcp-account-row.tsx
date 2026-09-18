import type { McpAccountSummary } from "@tulipfarm/schema";
import { useState } from "react";
import { StatusBadge } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { revokeMcpAccount, updateMcpAccount } from "~/lib/mcp-accounts";
import { useIsAdmin } from "~/lib/use-session-user";
import { McpCredentialFields } from "./mcp-account-form";
import { McpAccountGrants } from "./mcp-account-grants";
import { McpError, McpField } from "./mcp-form";
import { McpKnowledge } from "./mcp-knowledge";
import { McpOAuthSetup } from "./mcp-oauth-setup";

export function McpAccountRow({
  account,
  onChanged,
  requiredSlots = [],
}: {
  account: McpAccountSummary;
  onChanged: () => void;
  requiredSlots?: readonly string[];
}) {
  const isAdmin = useIsAdmin();
  const canManage = account.owner.scope === "personal" || isAdmin;
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [showGrants, setShowGrants] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const expired = account.expiresAt !== null && Date.parse(account.expiresAt) <= Date.now();
  async function act(action: () => Promise<unknown>) {
    setError(undefined);
    setPending(true);
    try {
      await action();
      setEditing(false);
      setConfirming(false);
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <li className="space-y-3 py-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{account.label}</p>
          <p className="break-all text-xs text-muted-foreground">
            {account.owner.scope} · {account.authentication} · {account.id}
            {account.isDefault ? " · Default for new selections" : ""}
          </p>
        </div>
        <StatusBadge
          label={
            expired
              ? "Expired"
              : account.status === "action_required"
                ? "Action required"
                : account.status
          }
          tone={
            expired || account.status === "action_required"
              ? "danger"
              : account.status === "active"
                ? "success"
                : "neutral"
          }
        />
      </header>
      <McpError error={error} />
      {account.oauthClient && (
        <p className="break-all text-xs text-muted-foreground">
          OAuth app: {account.oauthClient.clientId} ·{" "}
          {account.oauthClient.tokenEndpointAuthMethod === "none"
            ? "Public client"
            : "Registered confidential client"}
        </p>
      )}
      {account.authentication !== "none" && canManage && (
        <p className="text-xs text-muted-foreground">
          Replacing credentials or signing in again invalidates prior account consent and grants.
          Chats and Routines must be reviewed again.
        </p>
      )}
      {account.owner.scope === "personal" && (
        <p className="text-xs text-muted-foreground">
          Private Chat and personal Routines only. Routine results stay private to the owner.
        </p>
      )}
      {account.owner.scope === "shared" && (
        <p className="text-xs text-muted-foreground">
          Shared use requires admin grants and provider support. Chat grants do not grant Routine or
          Knowledge sync access.
        </p>
      )}
      {account.expiresAt && (
        <p className="text-xs text-muted-foreground">
          Expires: {new Date(account.expiresAt).toLocaleString()}
        </p>
      )}
      {canManage && account.status !== "revoked" && (
        <div className="space-y-3">
          {account.authentication === "oauth" && (
            <McpOAuthSetup
              key={`${account.id}:${account.revision}`}
              account={account}
              onChanged={onChanged}
            />
          )}
          {editing ? (
            <form
              className="max-w-sm space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void act(() =>
                  updateMcpAccount(account.integrationKey, account.id, { label: label.trim() })
                );
              }}
            >
              <McpField label="Account label">
                <Input
                  required
                  maxLength={128}
                  value={label}
                  disabled={pending}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </McpField>
              <div className="flex gap-2">
                <Button disabled={pending} type="submit">
                  Save label
                </Button>
                <Button
                  disabled={pending}
                  variant="outline"
                  type="button"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setEditing(true)}
              >
                Rename
              </Button>
              {!account.isDefault && account.status === "active" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    void act(() =>
                      updateMcpAccount(account.integrationKey, account.id, { isDefault: true })
                    )
                  }
                >
                  Make default
                </Button>
              )}
              {account.authentication === "token" && requiredSlots.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => setRepairing(true)}
                >
                  Replace token
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setConfirming(true)}
              >
                Disconnect account
              </Button>
            </div>
          )}
          {confirming && (
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">
                Disconnect {account.label}? Further use stops and synced copies are hidden, then
                purged. This does not undo completed external actions.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    void act(() => revokeMcpAccount(account.integrationKey, account.id))
                  }
                >
                  Confirm disconnect
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {repairing && (
            <form
              className="max-w-xl space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  try {
                    await updateMcpAccount(account.integrationKey, account.id, { values });
                    setRepairing(false);
                  } finally {
                    setValues({});
                  }
                });
              }}
            >
              <fieldset disabled={pending} className="space-y-3">
                <McpCredentialFields slots={requiredSlots} values={values} onChange={setValues} />
                <div className="flex gap-2">
                  <Button type="submit">Save replacement credentials</Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setValues({});
                      setRepairing(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </fieldset>
            </form>
          )}
        </div>
      )}
      {isAdmin && account.owner.scope === "shared" && account.status !== "revoked" && (
        <details onToggle={(event) => setShowGrants(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm font-medium">Manage shared access</summary>
          {showGrants && (
            <div className="mt-3">
              <McpAccountGrants account={account} />
            </div>
          )}
          {canManage && (
            <details onToggle={(event) => setShowKnowledge(event.currentTarget.open)}>
              <summary className="cursor-pointer text-sm font-medium">
                Manage Knowledge sync
              </summary>
              {showKnowledge && (
                <div className="mt-3">
                  <McpKnowledge account={account} />
                </div>
              )}
            </details>
          )}
        </details>
      )}
    </li>
  );
}
