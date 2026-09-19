import type { McpAccountCreate, McpIntegrationDefinition, McpTransport } from "@tulipfarm/schema";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { configureMcpIntegration } from "~/lib/mcp-integrations";
import { IntegrationChoice } from "./integration-choice";
import { McpError, McpField } from "./mcp-form";
import { McpTransportFields, transportDraft, transportInput } from "./mcp-transport-fields";

function availableId(name: string, existingIds: readonly string[]): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!/^[a-z]/.test(base)) base = `integration-${base}`;
  if (base === "github" || base === "slack") base = `${base}-mcp`;
  base = base.slice(0, 60).replace(/-$/, "");
  let candidate = base;
  let suffix = 2;
  while (existingIds.includes(candidate)) {
    const ending = `-${suffix++}`;
    candidate = `${base.slice(0, 64 - ending.length)}${ending}`;
  }
  return candidate;
}

export function McpServerForm({
  initial,
  suggestion,
  onSaved,
  onCancel,
  existingIds = [],
  supportedAuthentication,
}: {
  initial?: McpIntegrationDefinition;
  suggestion?: {
    id: string;
    label: string;
    transport?: McpTransport;
    authentication?: McpAccountCreate["authentication"];
    environment?: readonly string[];
    sharedAllowed?: boolean;
    authenticationMethods?: readonly McpAccountCreate["authentication"][];
  };
  onSaved: (server: McpIntegrationDefinition) => void;
  onCancel?: () => void;
  existingIds?: readonly string[];
  supportedAuthentication?: readonly McpAccountCreate["authentication"][];
}) {
  const [idOverride, setId] = useState(initial?.server.id ?? suggestion?.id);
  const [label, setLabel] = useState(initial?.server.label ?? suggestion?.label ?? "");
  const id = idOverride ?? availableId(label, existingIds);
  const [advanced, setAdvanced] = useState(false);
  const [transport, setTransport] = useState(
    transportDraft(initial?.server.transport ?? suggestion?.transport)
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [authentication, setAuthentication] = useState<McpAccountCreate["authentication"]>(
    initial?.server.authentication?.type ?? suggestion?.authentication ?? "token"
  );
  const [environment, setEnvironment] = useState(
    (initial?.server.authentication?.environment ?? suggestion?.environment)?.join("\n") ?? ""
  );
  const [sharedAllowed, setSharedAllowed] = useState(
    initial?.server.authentication?.sharedAllowed ?? suggestion?.sharedAllowed ?? false
  );
  let slackServer = false;
  if (transport.type === "streamable-http") {
    try {
      slackServer = new URL(transport.url).hostname.replace(/\.$/, "") === "mcp.slack.com";
    } catch {
      slackServer = false;
    }
  }
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const methods =
    supportedAuthentication ??
    suggestion?.authenticationMethods ??
    (suggestion?.authentication ? [suggestion.authentication] : undefined);
  const nameField = (
    <McpField label="Name">
      <Input
        required
        maxLength={256}
        value={label}
        onChange={(event) => setLabel(event.target.value)}
      />
    </McpField>
  );
  return (
    <form
      className="max-w-xl space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(undefined);
        setPending(true);
        try {
          if (methods && !methods.includes(authentication)) {
            throw new Error("Choose a sign-in method supported by this provider.");
          }
          if (id === "slack" || id === "github") {
            setAdvanced(true);
            throw new Error(
              "This ID is reserved for channel setup. Choose another Integration ID in Advanced settings."
            );
          }
          if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
            setAdvanced(true);
            throw new Error(
              "Use an Integration ID with lowercase letters, numbers and hyphens, starting with a letter."
            );
          }
          if (!initial && existingIds.includes(id)) {
            setAdvanced(true);
            throw new Error(
              "An integration already uses this ID. Choose another in Advanced settings, or manage the existing integration."
            );
          }
          const environmentNames = [
            ...new Set(
              environment
                .split("\n")
                .map((name) => name.trim())
                .filter(Boolean)
            ),
          ];
          if (transport.type === "stdio" && authentication === "oauth") {
            setAdvanced(true);
            throw new Error(
              "Provider sign-in is only available for online integrations. Choose an access token for a self-hosted integration."
            );
          }
          if (
            transport.type === "stdio" &&
            authentication === "token" &&
            (environmentNames.length === 0 ||
              environmentNames.length > 32 ||
              environmentNames.some((name) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)))
          ) {
            setAdvanced(true);
            throw new Error(
              "Check the required secret names in Advanced settings. Enter up to 32 names, one per line, starting with a letter. Add their values when you connect an account."
            );
          }
          const server = await configureMcpIntegration(id, {
            server: {
              id,
              label: label.trim(),
              transport: transportInput(transport),
              authentication: {
                type: authentication,
                ...(transport.type === "stdio" && authentication === "token"
                  ? { environment: environmentNames }
                  : {}),
                sharedAllowed: !slackServer && sharedAllowed,
              },
            },
            enabled,
          });
          onSaved(server);
        } catch (cause) {
          setError(cause);
        } finally {
          setPending(false);
        }
      }}
    >
      <McpError error={error} />
      <fieldset disabled={pending} className="space-y-4">
        {!initial && (
          <p className="text-sm text-muted-foreground">
            {suggestion
              ? `Add ${suggestion.label} to TulipFarm.`
              : "Add an integration from your provider."}{" "}
            Next, you’ll connect an account and choose what agents can do. Nothing is enabled yet.
          </p>
        )}
        {(!suggestion || initial) && nameField}
        {!initial && !suggestion && transport.type === "streamable-http" && (
          <McpField
            label="Integration URL"
            hint="Paste the MCP address supplied by your provider, not its website address. Never include an access token."
          >
            <Input
              type="url"
              required
              value={transport.url}
              placeholder="https://provider.example.com/mcp"
              onChange={(event) => setTransport({ ...transport, url: event.target.value })}
            />
          </McpField>
        )}
        <McpField label="Sign-in method">
          <IntegrationChoice
            label="Sign-in method"
            value={authentication}
            options={[
              { value: "token", label: "Access token" },
              ...(transport.type === "streamable-http"
                ? [{ value: "oauth", label: "Sign in with provider" }]
                : []),
              { value: "none", label: "No sign-in" },
            ].filter(({ value }) => !methods || methods.some((method) => method === value))}
            onChange={(value) => {
              if (value === "token" || value === "oauth" || value === "none")
                setAuthentication(value);
            }}
          />
        </McpField>
        {authentication === "token" && (
          <p className="text-xs text-muted-foreground">
            An access token is a secret key from your provider. You’ll enter it in the next step,
            when you connect your account.
          </p>
        )}
        {authentication === "oauth" && (
          <p className="text-xs text-muted-foreground">
            You’ll sign in on the provider’s website. Some providers first require your admin to
            register an app.
          </p>
        )}
        {transport.type === "stdio" && (
          <p className="text-xs text-muted-foreground">
            This integration runs on your infrastructure. Ask the person who runs TulipFarm to
            prepare its isolated runtime before connecting.
          </p>
        )}
        <details
          open={advanced}
          onToggle={(event) => setAdvanced(event.currentTarget.open)}
          className="border-t border-border pt-3"
        >
          <summary className="w-fit cursor-pointer text-sm font-medium">Advanced settings</summary>
          <div className="mt-4 space-y-4">
            {suggestion && !initial && nameField}
            <McpField
              label="Integration ID"
              hint="Used in links and automations. We choose this for you; it cannot be changed after setup."
            >
              <Input
                maxLength={64}
                value={id}
                disabled={!!initial}
                onChange={(event) => setId(event.target.value)}
              />
            </McpField>
            <McpTransportFields
              value={transport}
              onChange={setTransport}
              showUrl={!!initial || !!suggestion}
            />
            {authentication === "token" && transport.type === "stdio" && (
              <McpField
                label="Required secret names"
                hint="Names only, one per line, such as GITHUB_PERSONAL_ACCESS_TOKEN. Each account supplies its own encrypted values."
              >
                <textarea
                  className="min-h-20 rounded-md border border-input bg-background p-2 text-sm"
                  value={environment}
                  onChange={(event) => setEnvironment(event.target.value)}
                />
              </McpField>
            )}
            {authentication === "oauth" && transport.type === "stdio" && (
              <p role="alert" className="text-sm text-destructive">
                Choose an access token or no sign-in for a self-hosted integration.
              </p>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!slackServer && sharedAllowed}
                disabled={slackServer}
                onChange={(event) => setSharedAllowed(event.target.checked)}
              />
              Allow shared accounts
            </label>
            <p className="text-xs text-muted-foreground">
              {slackServer
                ? "Slack requires each person to sign in with their own account. Shared accounts are not allowed."
                : "Only allow this if your provider permits shared credentials. An admin must still choose who can use each shared account, including scheduled Routines."}
            </p>
            {initial && (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => setEnabled(event.target.checked)}
                  />
                  Integration enabled
                </label>
                <p className="text-xs text-muted-foreground">
                  Enabling does not grant account access or approve Tools. Review access separately.
                  Changing integration settings clears the previous access review.
                </p>
              </>
            )}
          </div>
        </details>
        <div className="flex gap-2">
          <Button type="submit">
            {pending ? "Saving..." : initial ? "Save settings" : "Continue"}
          </Button>
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </fieldset>
    </form>
  );
}
