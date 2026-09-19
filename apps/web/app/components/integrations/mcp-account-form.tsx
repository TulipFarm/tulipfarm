import type { McpAccountCreate } from "@tulipfarm/schema";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { createMcpAccount, startMcpAccountOAuth } from "~/lib/mcp-accounts";
import { useIsAdmin } from "~/lib/use-session-user";
import { IntegrationChoice } from "./integration-choice";
import { McpError, McpField } from "./mcp-form";

export function McpCredentialFields({
  slots,
  values,
  onChange,
}: {
  slots: readonly string[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  return (
    <>
      {slots.map((slot) => (
        <McpField
          key={slot}
          label={slot === "accessToken" ? "Access token" : slot}
          hint="Stored encrypted. Never shown to agents or read back here."
        >
          <Input
            type="password"
            autoComplete="new-password"
            maxLength={16_384}
            required
            value={values[slot] ?? ""}
            onChange={(event) => onChange({ ...values, [slot]: event.target.value })}
          />
        </McpField>
      ))}
    </>
  );
}

export function McpAccountForm({
  integrationKey,
  authentication,
  requiredSlots,
  sharedAllowed,
  onChanged,
  defaultLabel,
  requiresOAuthApp = false,
  prepare,
  onFailure,
  connect,
  consent,
  standardAccess,
}: {
  integrationKey: string;
  authentication: McpAccountCreate["authentication"];
  requiredSlots: readonly string[];
  sharedAllowed: boolean;
  onChanged: () => void;
  defaultLabel?: string;
  requiresOAuthApp?: boolean;
  prepare?: () => Promise<string>;
  onFailure?: (error: unknown) => void;
  connect?: (input: McpAccountCreate) => Promise<unknown>;
  consent?: string;
  standardAccess?: { consent: string; connect: (input: McpAccountCreate) => Promise<unknown> };
}) {
  const isAdmin = useIsAdmin();
  const [label, setLabel] = useState(defaultLabel ?? "");
  const [scope, setScope] = useState<McpAccountCreate["scope"]>("personal");
  const [isDefault, setIsDefault] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [existingOAuthApp, setExistingOAuthApp] = useState(requiresOAuthApp);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tokenEndpointAuthMethod, setTokenEndpointAuthMethod] = useState<
    NonNullable<McpAccountCreate["oauthClient"]>["tokenEndpointAuthMethod"]
  >(requiresOAuthApp ? "client_secret_post" : "none");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  return (
    <form
      className="max-w-xl space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(undefined);
        onFailure?.(undefined);
        setNotice("");
        let accountAttempted = false;
        try {
          const input: McpAccountCreate = {
            label: (label.trim() || defaultLabel || "").slice(0, 128),
            scope,
            authentication,
            ...(authentication === "oauth" ? {} : { isDefault }),
            ...(authentication === "token" ? { values } : {}),
            ...(authentication === "oauth" && existingOAuthApp
              ? {
                  oauthClient: {
                    clientId: clientId.trim(),
                    tokenEndpointAuthMethod,
                    ...(tokenEndpointAuthMethod !== "none" ? { clientSecret } : {}),
                  },
                }
              : {}),
          };
          if (connect) {
            const submitter = "submitter" in event.nativeEvent ? event.nativeEvent.submitter : null;
            if (
              standardAccess &&
              submitter instanceof HTMLButtonElement &&
              submitter.value === "use_standard_access"
            )
              await standardAccess.connect(input);
            else await connect(input);
            return;
          }
          const key = prepare ? await prepare() : integrationKey;
          accountAttempted = true;
          const account = await createMcpAccount(key, input);
          setValues({});
          setClientSecret("");
          setLabel(defaultLabel ?? "");
          if (authentication === "oauth") {
            if (existingOAuthApp) {
              setNotice(
                "Account saved. Register the OAuth callback URL shown on its account card with your provider, then choose Connect account."
              );
            } else {
              await startMcpAccountOAuth(key, account.id);
            }
          } else {
            setNotice(
              account.status === "active"
                ? "Account connected."
                : "Account saved. Further setup is required."
            );
          }
          onChanged();
        } catch (cause) {
          setError(cause);
          onFailure?.(cause);
          if (accountAttempted) onChanged();
        } finally {
          setValues({});
          setClientSecret("");
          setPending(false);
        }
      }}
    >
      {!onFailure && <McpError error={error} />}
      <fieldset disabled={pending} className="space-y-3">
        {!defaultLabel && (
          <McpField
            label="Account name"
            hint="Use a name you will recognize in Chat, such as your provider username or work account."
          >
            <Input
              required
              maxLength={128}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </McpField>
        )}
        {isAdmin && sharedAllowed ? (
          <McpField label="Who can use this account?">
            <IntegrationChoice
              label="Who can use this account?"
              value={scope}
              options={[
                { value: "personal", label: "Personal — just you" },
                { value: "shared", label: "Shared — people you grant access to" },
              ]}
              onChange={(value) => {
                if (value === "personal" || value === "shared") setScope(value);
              }}
            />
          </McpField>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {scope === "personal"
            ? "Personal · only you, in private Chat and your private Routines."
            : "Shared · Creating it grants no one access. Grant access after connecting; your provider must permit shared use."}
        </p>
        {authentication === "token" && (
          <div className="space-y-3">
            <McpCredentialFields slots={requiredSlots} values={values} onChange={setValues} />
          </div>
        )}
        {authentication === "oauth" && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {requiresOAuthApp
                ? "Enter your provider app details to get its callback URL, then sign in."
                : "Continue to your provider to sign in and choose permissions."}
            </p>
            <details
              open={requiresOAuthApp || undefined}
              onToggle={(event) => {
                if (!requiresOAuthApp) {
                  setExistingOAuthApp(event.currentTarget.open);
                  if (!event.currentTarget.open) setClientSecret("");
                }
              }}
            >
              <summary className="cursor-pointer text-sm font-medium">
                Use an existing OAuth app
              </summary>
              {existingOAuthApp && (
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Register an app in your provider's developer settings. After saving, copy the
                    callback URL into that app before signing in.
                  </p>
                  <McpField label="OAuth client ID">
                    <Input
                      required
                      maxLength={2048}
                      value={clientId}
                      autoComplete="off"
                      onChange={(event) => setClientId(event.target.value)}
                    />
                  </McpField>
                  <McpField label="Token endpoint authentication">
                    <IntegrationChoice
                      label="Token endpoint authentication"
                      value={tokenEndpointAuthMethod}
                      options={[
                        { value: "none", label: "None — public client" },
                        {
                          value: "client_secret_basic",
                          label: "Client secret in Authorization header",
                        },
                        { value: "client_secret_post", label: "Client secret in request body" },
                      ]}
                      onChange={(value) => {
                        if (
                          value === "none" ||
                          value === "client_secret_basic" ||
                          value === "client_secret_post"
                        ) {
                          setTokenEndpointAuthMethod(value);
                          setClientSecret("");
                        }
                      }}
                    />
                  </McpField>
                  {tokenEndpointAuthMethod !== "none" && (
                    <McpField label="OAuth client secret">
                      <Input
                        required
                        type="password"
                        maxLength={16_384}
                        autoComplete="new-password"
                        value={clientSecret}
                        onChange={(event) => setClientSecret(event.target.value)}
                      />
                    </McpField>
                  )}
                </div>
              )}
            </details>
          </div>
        )}
        {authentication === "none" && (
          <p className="text-xs text-muted-foreground">
            No provider password is needed. An admin must still review access, and agents can use
            only an authorized account.
          </p>
        )}
        <details className="space-y-2">
          <summary className="cursor-pointer text-xs font-medium">Account preferences</summary>
          {defaultLabel && (
            <McpField
              label="Account name"
              hint="Optional: choose a name to recognize this account in Chat."
            >
              <Input
                maxLength={128}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </McpField>
          )}
          {!connect && authentication !== "oauth" ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(event) => setIsDefault(event.target.checked)}
              />
              Default for new account selections
            </label>
          ) : !connect ? (
            <p className="text-xs text-muted-foreground">
              After sign-in succeeds, use Make default on the connected account if needed.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Changing a default does not change accounts already selected by a Chat or Routine.
          </p>
        </details>
        {consent && <p className="text-xs text-muted-foreground">{consent}</p>}
        <Button type="submit" variant={standardAccess ? "outline" : "default"}>
          {pending
            ? existingOAuthApp && authentication === "oauth"
              ? "Saving..."
              : "Connecting..."
            : connect
              ? standardAccess
                ? "Keep existing access and connect"
                : "Connect"
              : authentication === "oauth"
                ? existingOAuthApp
                  ? "Save OAuth account"
                  : "Sign in with provider"
                : "Connect account"}
        </Button>
        {standardAccess && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{standardAccess.consent}</p>
            <Button type="submit" value="use_standard_access">
              Use standard access and connect
            </Button>
          </div>
        )}
      </fieldset>
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </form>
  );
}
