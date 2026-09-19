import type { McpAccountSummary } from "@tulipfarm/schema";
import { useState } from "react";
import { StatusBadge } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ApiError } from "~/lib/api";
import { revokeMcpAccount, updateMcpAccount } from "~/lib/mcp-accounts";
import { useIsAdmin } from "~/lib/use-session-user";
import { McpCredentialFields } from "./mcp-account-form";
import { McpAccountGrants } from "./mcp-account-grants";
import { accountName } from "./mcp-account-selection";
import { McpError, McpField } from "./mcp-form";
import { McpKnowledge } from "./mcp-knowledge";
import { McpOAuthSetup } from "./mcp-oauth-setup";

export function McpAccountRow({
  account,
  accounts = [],
  onChanged,
  requiredSlots = [],
  definitionDigest,
  primary = true,
  definitionAuthentication,
  onError,
}: {
  account: McpAccountSummary;
  accounts?: readonly McpAccountSummary[];
  onChanged: () => void;
  requiredSlots?: readonly string[];
  definitionDigest?: string;
  primary?: boolean;
  definitionAuthentication?: McpAccountSummary["authentication"];
  onError?: (error: unknown) => void;
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
  const stale = definitionDigest !== undefined && account.definitionDigest !== definitionDigest;
  const needsRecovery =
    account.status !== "revoked" && (account.status !== "active" || expired || stale);
  const tokenPending = account.authentication === "token" && account.status === "pending";
  const requiresNewAccount =
    stale &&
    (account.authentication === "oauth" ||
      (definitionAuthentication !== undefined &&
        account.authentication !== definitionAuthentication));
  async function act(action: () => Promise<unknown>) {
    setError(undefined);
    onError?.(undefined);
    setPending(true);
    try {
      await action();
      setEditing(false);
      setConfirming(false);
      onChanged();
    } catch (cause) {
      const failure =
        cause instanceof ApiError && cause.status >= 500 && cause.code !== "probe_failed"
          ? new Error("TulipFarm could not finish this request. Try again on this account.")
          : cause;
      setError(failure);
      onError?.(failure);
      onChanged();
    } finally {
      setPending(false);
    }
  }
  return (
    <li className="space-y-3 py-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">{accountName(account, accounts)}</p>
          <p className="break-all text-xs text-muted-foreground">
            {account.owner.scope === "personal"
              ? "Personal · only you"
              : "Shared · access managed by admins"}
            {account.isDefault ? " · Default for new selections" : ""}
          </p>
        </div>
        <StatusBadge
          label={
            account.status === "revoked"
              ? "Disconnected"
              : stale
                ? "Settings changed"
                : expired
                  ? "Expired"
                  : account.status === "action_required"
                    ? "Action required"
                    : account.status === "active"
                      ? "Connected"
                      : account.status === "pending"
                        ? account.authentication === "oauth"
                          ? "Finish sign-in"
                          : "Verification incomplete"
                        : account.status
          }
          tone={
            stale || expired || account.status === "action_required"
              ? "danger"
              : account.status === "pending"
                ? "warning"
                : account.status === "active"
                  ? "success"
                  : "neutral"
          }
        />
      </header>
      {!onError && <McpError error={error} />}
      {canManage &&
        !needsRecovery &&
        !repairing &&
        account.status !== "revoked" &&
        account.authentication === "token" &&
        requiredSlots.length > 0 && (
          <Button variant="outline" disabled={pending} onClick={() => setRepairing(true)}>
            Replace token
          </Button>
        )}
      {needsRecovery && (
        <div className="space-y-3 rounded-md border border-border bg-muted/40 p-3">
          <p className="text-sm">
            {tokenPending
              ? "Your account was saved, but token verification did not finish."
              : stale
                ? "This account uses earlier integration settings."
                : expired
                  ? "This account's access has expired."
                  : account.authentication === "oauth"
                    ? "Finish provider sign-in to connect this account."
                    : "This account needs attention before it can be used."}
          </p>
          {!canManage ? (
            <p className="text-xs text-muted-foreground">
              Ask an admin to reconnect this shared account, or connect your own.
            </p>
          ) : requiresNewAccount ? (
            <p className="text-xs text-muted-foreground">
              Connect a new account for the current sign-in settings. This account's credentials
              cannot be reused.
            </p>
          ) : account.authentication === "token" && requiredSlots.length > 0 ? (
            <>
              <p className="text-xs text-muted-foreground">
                Re-enter your token to verify this same account. No new account will be created.
              </p>
              {!repairing && (
                <Button
                  variant={primary ? "default" : "outline"}
                  disabled={pending}
                  onClick={() => setRepairing(true)}
                >
                  {tokenPending ? "Verify token" : "Update token"}
                </Button>
              )}
              {account.status === "revoked" && (
                <p className="text-xs text-muted-foreground">
                  This account is disconnected. Connect another account to continue.
                </p>
              )}
            </>
          ) : account.authentication === "none" ? (
            <p className="text-xs text-muted-foreground">
              Ask an admin to check the integration settings.
            </p>
          ) : null}
        </div>
      )}
      {canManage && repairing && (
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
            <p className="text-sm">
              This replaces the token for this account. It does not create another account.
            </p>
            {!tokenPending && (
              <p className="text-xs text-muted-foreground">
                Replacing credentials clears previous consent and access grants. Review affected
                Chats and Routines again.
              </p>
            )}
            <McpCredentialFields slots={requiredSlots} values={values} onChange={setValues} />
            <div className="flex gap-2">
              <Button type="submit">
                {pending
                  ? "Verifying..."
                  : tokenPending
                    ? "Verify this account"
                    : "Save replacement credentials"}
              </Button>
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
      {canManage && needsRecovery && !requiresNewAccount && account.authentication === "oauth" && (
        <McpOAuthSetup
          key={`${account.id}:${account.revision}`}
          account={account}
          onChanged={onChanged}
          primary={primary}
        />
      )}
      <details className="space-y-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {canManage ? "Account options" : "Account details"}
        </summary>
        {canManage && account.status !== "revoked" && (
          <div className="space-y-3">
            {account.authentication === "oauth" && !needsRecovery && (
              <details className="space-y-3">
                <summary className="cursor-pointer text-sm font-medium">Sign-in settings</summary>
                <McpOAuthSetup
                  key={`${account.id}:${account.revision}`}
                  account={account}
                  onChanged={onChanged}
                />
              </details>
            )}
            <div className="space-y-3">
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
                  <McpField label="Account name">
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
                      Save name
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
            </div>
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
          </details>
        )}
        {canManage && account.status !== "revoked" && (
          <details
            onToggle={(event) => setShowKnowledge(event.currentTarget.open)}
            className="space-y-3"
          >
            <summary className="cursor-pointer text-sm font-medium">Manage Knowledge sync</summary>
            {showKnowledge && (
              <div className="mt-3">
                <McpKnowledge account={account} />
              </div>
            )}
          </details>
        )}
        <details className="space-y-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Technical details</summary>
          <p className="break-all">
            Account ID: <code>{account.id}</code>
          </p>
          <p>
            Sign-in method:{" "}
            {account.authentication === "oauth"
              ? "Provider sign-in"
              : account.authentication === "token"
                ? "Access token"
                : "No sign-in required"}
          </p>
          {account.oauthClient && (
            <p className="break-all">
              OAuth app: {account.oauthClient.clientId} ·{" "}
              {account.oauthClient.tokenEndpointAuthMethod === "none"
                ? "Public client"
                : "Registered confidential client"}
            </p>
          )}
          {account.expiresAt && <p>Expires: {new Date(account.expiresAt).toLocaleString()}</p>}
        </details>
      </details>
    </li>
  );
}
