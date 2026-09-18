import { useState } from "react";
import { MarkdownView } from "~/components/markdown-view";
import { StatusBadge } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import { CopyField } from "~/components/ui/copy-field";
import { Link } from "~/components/ui/link";
import {
  connectIntegration,
  disconnectGitHubInstallation,
  disconnectIntegration,
  type GitHubInstallation,
  type IntegrationDetail,
} from "~/lib/integrations";
import { useIsAdmin } from "~/lib/use-session-user";
import { IntegrationAuthFlow, startHandoff } from "./auth-flow";
import { IntegrationIcon } from "./integration-icon";
import { NativeChannelRoutes } from "./native-channel-routes";

export function NativeChannelDetail({
  integration,
  installations,
  routesError,
  callbackError,
  onChanged,
}: {
  integration: IntegrationDetail;
  installations: GitHubInstallation[];
  routesError?: string;
  callbackError?: string;
  onChanged: () => void;
}) {
  const isAdmin = useIsAdmin();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const steps = integration.auth.filter((step) => !step.personal);
  const connected =
    integration.connected && steps.every((step) => !step.producesEnv || step.satisfied);
  const installStep = steps.find((step) => step.kind === "install");
  const title = integration.title ?? integration.name;

  async function act(key: string, action: () => Promise<unknown>) {
    setPending(key);
    setError(undefined);
    try {
      await action();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The channel could not be updated.");
    } finally {
      setPending(undefined);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Link to="/integrations" className="text-sm text-brand hover:underline">
        Back to Integrations
      </Link>
      <header className="flex items-center gap-3">
        <IntegrationIcon
          label={title}
          iconSlug={integration.iconSlug}
          iconPath={integration.iconPath}
          iconColor={integration.iconColor}
          size="lg"
        />
        <div className="flex-1">
          <h2 className="text-lg font-semibold">{title} channel</h2>
          <p className="text-xs text-muted-foreground">
            Native events and replies. Agent actions use a separate MCP Integration.
          </p>
        </div>
        <StatusBadge
          label={connected ? "Credentials connected" : "Not connected"}
          tone={connected ? "success" : "neutral"}
        />
      </header>
      {integration.description && (
        <p className="text-sm text-muted-foreground">{integration.description}</p>
      )}
      {[error, callbackError, integration.errorMessage, routesError]
        .filter(Boolean)
        .map((message) => (
          <p key={message} role="alert" className="text-sm text-destructive">
            {message}
          </p>
        ))}
      {!connected && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Connect channel</h3>
          {!isAdmin ? (
            <p className="text-sm text-muted-foreground">Ask an admin to connect this channel.</p>
          ) : steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No channel setup steps are available.</p>
          ) : steps.every((step) => step.satisfied) ? (
            <Button
              disabled={!!pending}
              onClick={() => void act("connect", () => connectIntegration(integration.name, {}))}
            >
              {pending === "connect" ? "Reconnecting..." : "Reconnect"}
            </Button>
          ) : (
            <IntegrationAuthFlow
              slug={integration.name}
              providerLabel={title}
              steps={steps}
              onAdvance={onChanged}
              calloutError={callbackError}
            />
          )}
        </section>
      )}
      {integration.name === "github" && connected && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">GitHub App installations</h3>
          {installations.length === 0 && !routesError && (
            <p className="text-sm text-muted-foreground">
              The App is not installed on any account yet.
            </p>
          )}
          <ul className="divide-y divide-border">
            {installations.map((installation) => (
              <li
                key={installation.installationId}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{installation.account}</p>
                  <p className="break-words text-xs text-muted-foreground">
                    {installation.repositories.join(", ") || "No repositories yet"}
                  </p>
                </div>
                {isAdmin && (
                  <Button
                    variant="outline"
                    disabled={!!pending}
                    onClick={() =>
                      void act(installation.installationId, () =>
                        disconnectGitHubInstallation(installation.installationId)
                      )
                    }
                  >
                    Disconnect
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            {isAdmin && installStep && (
              <Button
                disabled={!!pending}
                onClick={() =>
                  void act("install", () => startHandoff(integration.name, installStep.index))
                }
              >
                Add another install
              </Button>
            )}
            <a
              href="https://github.com/settings/installations"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-brand hover:underline"
            >
              Manage repositories on GitHub
            </a>
          </div>
        </section>
      )}
      {integration.name === "slack" && connected && !isAdmin && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Channel routing</h3>
          <p className="text-sm text-muted-foreground">
            Linked users can ask agents for help in Slack. Personal MCP accounts cannot be used in
            shared channels. Slack content is not synced into Knowledge.
          </p>
          <Link to="/agents" className="text-sm text-brand hover:underline">
            Manage Agent channel bindings
          </Link>
        </section>
      )}
      {connected && isAdmin && (integration.name === "slack" || integration.name === "github") && (
        <NativeChannelRoutes provider={integration.name} />
      )}
      {integration.ingress?.webhookUrl && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Webhook URL</h3>
          <CopyField value={integration.ingress.webhookUrl} />
        </section>
      )}
      {integration.grants.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Provider permissions</h3>
          <ul className="divide-y divide-border">
            {integration.grants.map((grant) => (
              <li key={grant.label} className="py-2 text-sm">
                <code>{grant.label}</code>
                {grant.access ? ` · ${grant.access}` : ""}
                <p className="text-xs text-muted-foreground">{grant.description}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {integration.setupGuide && (
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Setup guide</summary>
          <MarkdownView>{integration.setupGuide}</MarkdownView>
        </details>
      )}
      {connected && isAdmin && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Disconnect channel</h3>
          <p className="text-xs text-muted-foreground">
            Stops native channel events and replies. MCP accounts are managed separately.
          </p>
          <Button
            variant="outline"
            disabled={!!pending}
            onClick={() => void act("disconnect", () => disconnectIntegration(integration.name))}
          >
            {pending === "disconnect" ? "Disconnecting..." : "Disconnect"}
          </Button>
        </section>
      )}
    </div>
  );
}
