import type { McpAccountCreate, McpIntegrationDefinition, McpTransport } from "@tulipfarm/schema";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { configureMcpIntegration } from "~/lib/mcp-integrations";
import { IntegrationChoice } from "./integration-choice";
import { McpError, McpField } from "./mcp-form";
import { McpTransportFields, transportDraft, transportInput } from "./mcp-transport-fields";

export function McpServerForm({
  initial,
  suggestion,
  onSaved,
  onCancel,
  existingIds = [],
}: {
  initial?: McpIntegrationDefinition;
  suggestion?: {
    id: string;
    label: string;
    transport?: McpTransport;
    authentication?: McpAccountCreate["authentication"];
    environment?: readonly string[];
    sharedAllowed?: boolean;
  };
  onSaved: (server: McpIntegrationDefinition) => void;
  onCancel?: () => void;
  existingIds?: readonly string[];
}) {
  const [id, setId] = useState(initial?.server.id ?? suggestion?.id ?? "");
  const [label, setLabel] = useState(initial?.server.label ?? suggestion?.label ?? "");
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
  return (
    <form
      className="max-w-xl space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(undefined);
        setPending(true);
        try {
          if (id === "slack" || id === "github") {
            throw new Error(
              "Slack and GitHub are reserved native channel IDs. Use slack-mcp or github-mcp for an MCP server."
            );
          }
          if (!initial && existingIds.includes(id)) {
            throw new Error(
              "An Integration already uses this ID. Choose a different ID or edit the existing server."
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
            throw new Error("Browser sign-in is only supported for remote MCP servers.");
          }
          if (
            transport.type === "stdio" &&
            authentication === "token" &&
            (environmentNames.length === 0 ||
              environmentNames.length > 32 ||
              environmentNames.some((name) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)))
          ) {
            throw new Error(
              "Enter up to 32 credential environment names, one name per line, starting with a letter. Do not enter secret values here."
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
        <McpField
          label="Integration ID"
          hint="Lowercase letters, digits and hyphens. github and slack are reserved for native channels; use github-mcp or slack-mcp for MCP. This ID stays in links and Routine bindings."
        >
          <Input
            required
            pattern={"[a-z][a-z0-9\\-]{0,63}"}
            maxLength={64}
            value={id}
            disabled={!!initial}
            onChange={(event) => setId(event.target.value)}
          />
        </McpField>
        <McpField label="Display name">
          <Input
            required
            maxLength={256}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </McpField>
        <McpTransportFields value={transport} onChange={setTransport} />
        <McpField label="Account authentication">
          <IntegrationChoice
            label="Account authentication"
            value={authentication}
            options={[
              { value: "token", label: "Token" },
              ...(transport.type === "streamable-http"
                ? [{ value: "oauth", label: "Browser sign-in (OAuth)" }]
                : []),
              { value: "none", label: "No credentials" },
            ]}
            onChange={(value) => {
              if (value === "token" || value === "oauth" || value === "none")
                setAuthentication(value);
            }}
          />
        </McpField>
        {authentication === "token" && transport.type === "streamable-http" && (
          <p className="text-xs text-muted-foreground">
            Each account supplies its own access token. Remote requests use Bearer authentication.
            Token values are collected under Accounts, never in this server definition.
          </p>
        )}
        {authentication === "token" && transport.type === "stdio" && (
          <McpField
            label="Credential environment names"
            hint="Names only, one per line, such as GITHUB_PERSONAL_ACCESS_TOKEN. Each account supplies its own encrypted values."
          >
            <textarea
              required
              className="min-h-20 rounded-md border border-input bg-background p-2 text-sm"
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
            />
          </McpField>
        )}
        {authentication === "oauth" && transport.type === "stdio" && (
          <p role="alert" className="text-sm text-destructive">
            Choose token or no credentials for an isolated local server.
          </p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!slackServer && sharedAllowed}
            disabled={slackServer}
            onChange={(event) => setSharedAllowed(event.target.checked)}
          />
          Permit admin-managed shared accounts
        </label>
        <p className="text-xs text-muted-foreground">
          {slackServer
            ? "Slack MCP requires personal user authorization. Shared accounts are not allowed."
            : "Enable only when the provider permits shared credentials. Shared accounts still require explicit user, Team or Routine grants."}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable this MCP server
        </label>
        <p className="text-xs text-muted-foreground">
          Enabling a server does not approve its capabilities or grant account access. Discover and
          explicitly approve Tools, resources and prompts. Changing server settings clears its
          capability review.
        </p>
        <div className="flex gap-2">
          <Button type="submit">
            {pending ? "Saving..." : initial ? "Save server" : "Add server"}
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
