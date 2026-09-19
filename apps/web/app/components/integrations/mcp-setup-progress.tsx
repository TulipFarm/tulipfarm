import type { McpAccountSummary } from "@tulipfarm/schema";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { listMcpAccounts, type McpAccountConfiguration } from "~/lib/mcp-accounts";
import type { McpSetupOperation } from "~/lib/mcp-setup";
import { mcpAccessMessage } from "./mcp-access-message";
import { McpCredentialFields } from "./mcp-account-form";
import { McpError, McpField } from "./mcp-form";
import { McpOAuthSetup } from "./mcp-oauth-setup";
import type { useMcpSetup } from "./use-mcp-setup";

export function McpSetupProgress({
  setup,
  configuration,
  account,
  publishedReady = false,
  oauthReturned = false,
  onDone,
  onRestart,
  standardAccess,
}: {
  setup: ReturnType<typeof useMcpSetup>;
  configuration?: McpAccountConfiguration;
  account?: McpAccountSummary;
  publishedReady?: boolean;
  oauthReturned?: boolean;
  onDone?: () => void;
  onRestart?: () => void;
  standardAccess?: { consent: string; connect: () => void };
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [clientSecret, setClientSecret] = useState("");
  const { operation, pending, uncertain, error } = setup;
  const usableAccess = operation?.access?.enabled && operation.access.state === "allowed";
  const failureCode = operation?.error;
  const requiresNewConsent =
    failureCode === "definition_changed" ||
    failureCode === "capability_changed" ||
    failureCode === "account_binding_changed" ||
    (operation?.status === "retry" && failureCode === "reconnect_required");
  const staleToken =
    operation?.status === "retry" &&
    failureCode === "account_binding_changed" &&
    account?.id === operation.accountId &&
    account?.authentication === "token" &&
    configuration?.authentication === "token" &&
    configuration.definitionDigest !== undefined &&
    account.definitionDigest !== configuration.definitionDigest;
  const explanations: Record<string, string> = {
    setup_failed: "TulipFarm could not finish setup. Your saved progress is kept; try again.",
    account_binding_changed:
      "This account changed after setup began. Continue with its current settings instead of retrying the old approval.",
    definition_changed:
      "Integration settings changed after setup began. Continue with the current settings instead of retrying the old approval.",
    capability_changed:
      "The saved access snapshot cannot be reused. Current access restrictions will be preserved.",
    probe_failed:
      "The provider could not verify this account. Check its credentials and try again.",
    reconnect_required:
      "The provider requires this account to reconnect. Your saved access restrictions are unchanged.",
    account_unavailable: "The saved account is no longer available.",
  };
  const expected = [
    "sign_in_required",
    "credentials_required",
    "oauth_client_secret_required",
    "admin_required",
    "initial_consent_required",
  ];
  const failure = staleToken
    ? "This account uses earlier integration settings. Re-enter its token to verify the current settings."
    : failureCode && !expected.includes(failureCode)
      ? (explanations[failureCode] ??
        "TulipFarm could not finish setup. Your saved progress is kept; try again.")
      : undefined;

  if (pending)
    return (
      <div aria-busy="true" className="space-y-2 py-2">
        <p role="status" className="text-sm font-medium">
          Connecting...
        </p>
        <p className="text-xs text-muted-foreground">
          Checking the account and finishing its saved setup.
        </p>
      </div>
    );

  if (uncertain || !operation)
    return (
      <div className="space-y-3">
        <McpError error={error} />
        <p className="text-sm">The setup result could not be confirmed.</p>
        <p className="text-xs text-muted-foreground">
          Check its saved status before trying again. No new account will be created.
        </p>
        <Button onClick={() => void setup.refresh()}>Check connection status</Button>
      </div>
    );

  return (
    <section aria-label="Connection progress" className="space-y-3">
      <McpError error={error} />
      {failure && <McpError error={new Error(failure)} />}
      {operation.status === "done" ? (
        <>
          <p role="status" className="text-sm font-semibold">
            {operation.access && !usableAccess ? "Connected — access needs attention" : "Connected"}
          </p>
          <p className="text-xs text-muted-foreground">{mcpAccessMessage(operation.access)}</p>
          {!usableAccess && standardAccess ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{standardAccess.consent}</p>
              <Button onClick={standardAccess.connect}>Use standard access and connect</Button>
            </div>
          ) : !usableAccess ? (
            onRestart ? (
              <Button onClick={onRestart}>Review integration access</Button>
            ) : (
              <Button asChild>
                <Link to={`/integrations/${encodeURIComponent(operation.integrationKey)}`}>
                  Review integration access
                </Link>
              </Button>
            )
          ) : onDone ? (
            <Button onClick={onDone}>Done</Button>
          ) : (
            <Button asChild>
              <Link to="/">Open Chat</Link>
            </Button>
          )}
          {!usableAccess && onDone && (
            <Button variant="ghost" onClick={onDone}>
              Done
            </Button>
          )}
        </>
      ) : failureCode === "account_unavailable" ? (
        <>
          <p className="text-sm font-medium">Choose an available account</p>
          <p className="text-xs text-muted-foreground">
            This saved account can no longer be used. Choose another account or connect a new one
            from the integration.
          </p>
          {onRestart ? (
            <Button onClick={onRestart}>Use current settings</Button>
          ) : (
            <Button asChild>
              <Link to={`/integrations/${encodeURIComponent(operation.integrationKey)}`}>
                Open integration
              </Link>
            </Button>
          )}
        </>
      ) : operation.status === "needs_sign_in" ? (
        <SetupSignIn
          operation={operation}
          forceSignIn={operation.error === "reconnect_required" && !oauthReturned}
          onChanged={() => void setup.refresh()}
          onContinue={() => void setup.resume()}
        />
      ) : operation.status === "needs_admin" ? (
        <>
          <p className="text-sm font-medium">
            {publishedReady ? "Finish connecting" : "An admin needs to finish setup"}
          </p>
          <p className="text-xs text-muted-foreground">
            {publishedReady
              ? "Approved access is ready. Continue your saved account setup."
              : "An admin must enable the integration with approved access. Then finish your saved setup here."}
          </p>
          {failureCode === "initial_consent_required" && onRestart ? (
            <Button onClick={onRestart}>Use current settings</Button>
          ) : (
            <Button variant="outline" onClick={() => void setup.resume()}>
              Finish connecting
            </Button>
          )}
        </>
      ) : operation.status === "needs_credentials" || staleToken ? (
        configuration ? (
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                await setup.resume(
                  configuration.authentication === "oauth" ? { clientSecret } : { values }
                );
              } finally {
                setValues({});
                setClientSecret("");
              }
            }}
          >
            <p className="text-sm font-medium">Continue your saved setup</p>
            <p className="text-xs text-muted-foreground">
              Enter the required credentials to continue this setup. This does not create another
              account.
            </p>
            {configuration.authentication === "oauth" ? (
              <McpField label="OAuth client secret">
                <Input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
              </McpField>
            ) : (
              <McpCredentialFields
                slots={configuration.requiredSlots}
                values={values}
                onChange={setValues}
              />
            )}
            <Button type="submit">Continue connecting</Button>
          </form>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            Account setup fields could not be loaded. Reload this integration before entering
            credentials.
          </p>
        )
      ) : (
        <>
          <p className="text-sm font-medium">Finish connecting</p>
          <p className="text-xs text-muted-foreground">
            {requiresNewConsent
              ? "The saved access approval cannot be reused. Check current settings before continuing."
              : "Continue the setup you already approved, using the same account and access settings."}
          </p>
          {requiresNewConsent ? (
            onRestart ? (
              <Button onClick={onRestart}>Use current settings</Button>
            ) : (
              <Button asChild>
                <Link to={`/integrations/${encodeURIComponent(operation.integrationKey)}`}>
                  Open integration
                </Link>
              </Button>
            )
          ) : (
            <Button onClick={() => void setup.resume()}>Finish connecting</Button>
          )}
        </>
      )}
    </section>
  );
}

function SetupSignIn({
  operation,
  forceSignIn,
  onChanged,
  onContinue,
}: {
  operation: McpSetupOperation;
  forceSignIn: boolean;
  onChanged: () => void;
  onContinue: () => void;
}) {
  const [account, setAccount] = useState<McpAccountSummary>();
  const [error, setError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads the exact saved account.
  useEffect(() => {
    let live = true;
    setAccount(undefined);
    setError(undefined);
    listMcpAccounts(operation.integrationKey)
      .then((accounts) => {
        const current = accounts.find((item) => item.id === operation.accountId);
        if (!current) throw new Error("The saved sign-in account could not be found.");
        if (live) setAccount(current);
      })
      .catch((cause) => {
        if (live) setError(cause);
      });
    return () => {
      live = false;
    };
  }, [operation.integrationKey, operation.accountId, attempt]);
  return (
    <div className="space-y-3">
      <McpError error={error} />
      {!forceSignIn &&
      account?.status === "active" &&
      (!account.expiresAt || Date.parse(account.expiresAt) > Date.now()) ? (
        <>
          <p className="text-sm font-medium">Provider sign-in is complete</p>
          <p className="text-xs text-muted-foreground">
            Finish the setup you already approved for {account.label}.
          </p>
          <Button onClick={onContinue}>Finish connecting</Button>
        </>
      ) : account ? (
        <McpOAuthSetup account={account} primary onChanged={onChanged} />
      ) : error ? (
        <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          Reload saved account
        </Button>
      ) : (
        <p role="status" className="text-xs text-muted-foreground">
          Preparing provider sign-in...
        </p>
      )}
    </div>
  );
}
