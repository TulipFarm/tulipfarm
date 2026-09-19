import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { startMcpAccountOAuth } from "~/lib/mcp-accounts";
import {
  getMcpCatalogSetup,
  type McpCatalogEntry,
  type McpCatalogSetup,
} from "~/lib/mcp-integrations";
import { setupAccountInput } from "~/lib/mcp-setup";
import { IntegrationChoice } from "./integration-choice";
import { IntegrationSetupGuide } from "./integration-setup-guide";
import { McpAccountForm } from "./mcp-account-form";
import { McpError } from "./mcp-form";
import { McpSetupProgress } from "./mcp-setup-progress";
import { useMcpSetup } from "./use-mcp-setup";

export const INITIAL_SETUP_CONSENT =
  "Connect allows agents to use this account's current Tools and content. Every initial Tool call still requires approval. Future additions stay off, and existing restrictions are kept.";

export function McpProviderSetup({
  entry,
  onChanged,
  onDone,
}: {
  entry: McpCatalogEntry;
  onChanged: () => void;
  onDone?: () => void;
}) {
  const [authentication, setAuthentication] = useState<"token" | "oauth">(
    entry.authentication.includes("token") ? "token" : "oauth"
  );
  const [metadata, setMetadata] = useState<McpCatalogSetup>();
  const [error, setError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const setup = useMcpSetup(onChanged);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads trusted setup metadata.
  useEffect(() => {
    let live = true;
    setMetadata(undefined);
    setError(undefined);
    getMcpCatalogSetup(entry.id, authentication)
      .then((value) => {
        if (live) setMetadata(value);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause);
      });
    return () => {
      live = false;
    };
  }, [entry.id, authentication, attempt]);

  const submitted = setup.pending || setup.operation || setup.uncertain;
  return (
    <div className="space-y-4">
      <McpError error={error} />
      {submitted ? (
        <McpSetupProgress setup={setup} configuration={metadata?.configuration} onDone={onDone} />
      ) : (
        <>
          <IntegrationSetupGuide entry={entry} />
          <McpError error={setup.error} />
          {entry.authentication.length > 1 && (
            <IntegrationChoice
              label="Sign-in method"
              value={authentication}
              options={entry.authentication.map((value) => ({
                value,
                label: value === "token" ? "Access token" : "Sign in with provider",
              }))}
              onChange={(value) => {
                if (value === "token" || value === "oauth") setAuthentication(value);
              }}
            />
          )}
          {!metadata && !error && <p role="status">Loading account setup...</p>}
          {!metadata && error && (
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              Retry account setup
            </Button>
          )}
          {metadata && (
            <McpAccountForm
              key={authentication}
              integrationKey={metadata.server.id}
              {...metadata.configuration}
              requiresOAuthApp={authentication === "oauth" && metadata.requiresOAuthApp}
              defaultLabel={`${entry.name} account`}
              consent={INITIAL_SETUP_CONSENT}
              connect={async (input) => {
                const saved = await setup.start({
                  providerId: entry.id,
                  authentication,
                  ...setupAccountInput(input),
                  initializePolicy: true,
                });
                if (
                  saved?.status === "needs_sign_in" &&
                  saved.accountId &&
                  input.authentication === "oauth" &&
                  !input.oauthClient
                ) {
                  await startMcpAccountOAuth(saved.integrationKey, saved.accountId);
                }
              }}
              onFailure={setError}
              onChanged={onChanged}
            />
          )}
        </>
      )}
    </div>
  );
}
