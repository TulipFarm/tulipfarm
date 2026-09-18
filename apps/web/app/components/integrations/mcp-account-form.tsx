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
          hint="Stored encrypted. Never sent to the Agent or read back in the UI."
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
}: {
  integrationKey: string;
  authentication: McpAccountCreate["authentication"];
  requiredSlots: readonly string[];
  sharedAllowed: boolean;
  onChanged: () => void;
}) {
  const isAdmin = useIsAdmin();
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<McpAccountCreate["scope"]>("personal");
  const [isDefault, setIsDefault] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [existingOAuthApp, setExistingOAuthApp] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tokenEndpointAuthMethod, setTokenEndpointAuthMethod] =
    useState<NonNullable<McpAccountCreate["oauthClient"]>["tokenEndpointAuthMethod"]>("none");
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
        setNotice("");
        try {
          const account = await createMcpAccount(integrationKey, {
            label: label.trim(),
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
          });
          setValues({});
          setClientSecret("");
          setLabel("");
          onChanged();
          if (authentication === "oauth") {
            if (existingOAuthApp) {
              setNotice(
                "Account saved. Register the OAuth callback URL shown on its account card with your provider, then choose Connect account."
              );
            } else {
              await startMcpAccountOAuth(integrationKey, account.id);
            }
          } else {
            setNotice(
              account.status === "active"
                ? "Account connected."
                : "Account saved. Further setup is required."
            );
          }
        } catch (cause) {
          setError(cause);
          onChanged();
        } finally {
          setValues({});
          setClientSecret("");
          setPending(false);
        }
      }}
    >
      <h4 className="text-sm font-medium">Connect another account</h4>
      <McpError error={error} />
      <fieldset disabled={pending} className="space-y-3">
        <McpField
          label="Account label"
          hint="Choose a label that identifies this exact account in Chat."
        >
          <Input
            required
            maxLength={128}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </McpField>
        {isAdmin && sharedAllowed ? (
          <McpField label="Account ownership">
            <IntegrationChoice
              label="Account ownership"
              value={scope}
              options={[
                { value: "personal", label: "Personal — only your identity" },
                { value: "shared", label: "Shared — admin-managed access" },
              ]}
              onChange={(value) => {
                if (value === "personal" || value === "shared") setScope(value);
              }}
            />
          </McpField>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {scope === "personal"
            ? "Personal by default. Use only in private Chat or owner-private Routines. Shared channels cannot use your personal credentials."
            : "Shared accounts need explicit grants and provider permission. Creating this account grants no one access."}
        </p>
        {!sharedAllowed && (
          <p className="text-xs text-muted-foreground">
            Shared accounts are not supported for this server.
          </p>
        )}
        {authentication === "token" && (
          <McpCredentialFields slots={requiredSlots} values={values} onChange={setValues} />
        )}
        {authentication === "oauth" && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              TulipFarm completes authorization on the server; no tokens appear in this form or its
              URL. Existing OAuth apps are saved first so you can register the callback URL before
              sign-in.
            </p>
            <details
              onToggle={(event) => {
                setExistingOAuthApp(event.currentTarget.open);
                if (!event.currentTarget.open) setClientSecret("");
              }}
            >
              <summary className="cursor-pointer text-sm font-medium">
                Use an existing OAuth app
              </summary>
              {existingOAuthApp && (
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Use your provider's registered client settings. Without these settings,
                    TulipFarm attempts dynamic client registration only when the provider supports
                    it. Client secrets are encrypted and never read back.
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
            This server requires no external credential. Its capabilities still need admin approval
            and account-use authorization.
          </p>
        )}
        {authentication !== "oauth" ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
            />
            Default for new account selections
          </label>
        ) : (
          <p className="text-xs text-muted-foreground">
            After sign-in succeeds, use Make default on the connected account if needed.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Changing a default does not change accounts already selected by a Chat or Routine.
        </p>
        <Button type="submit">
          {pending
            ? existingOAuthApp && authentication === "oauth"
              ? "Saving..."
              : "Connecting..."
            : authentication === "oauth"
              ? existingOAuthApp
                ? "Save OAuth account"
                : "Connect with browser sign-in"
              : "Connect account"}
        </Button>
      </fieldset>
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </form>
  );
}
