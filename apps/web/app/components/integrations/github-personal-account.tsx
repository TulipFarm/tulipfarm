import { useState } from "react";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { disconnectPersonalIntegration, type IntegrationDetail } from "~/lib/integrations";
import { startHandoff } from "./auth-flow";

function errMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "request failed";
}

interface GitHubPersonalAccountProps {
  readonly integration: Pick<IntegrationDetail, "name" | "auth" | "personalConnected">;
  readonly callbackError: string | undefined;
  readonly onChanged: () => void;
}

/** A person's GitHub credential is independent from the business App connection above it. */
export function GitHubPersonalAccount({
  integration,
  callbackError,
  onChanged,
}: GitHubPersonalAccountProps) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const step = integration.auth?.find((candidate) => candidate.personal);
  if (step === undefined) return null;
  const stepIndex = step.index;

  async function connect() {
    setBusy(true);
    setActionError(undefined);
    try {
      await startHandoff(integration.name, stepIndex, false, undefined, "user");
    } catch (error) {
      setActionError(errMessage(error));
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setActionError(undefined);
    try {
      await disconnectPersonalIntegration(integration.name);
      onChanged();
    } catch (error) {
      setActionError(errMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">Your GitHub account</h2>
      <p className="max-w-prose text-xs text-muted-foreground">
        GitHub Tools used in Chat act with your GitHub permissions. They never fall back to the
        business&apos;s GitHub App when your account is not connected.
      </p>
      {(callbackError ?? actionError) && (
        <p className="text-sm text-destructive">{callbackError ?? actionError}</p>
      )}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant={integration.personalConnected ? "outline" : "default"}
          disabled={busy}
          onClick={connect}
        >
          {busy
            ? "Opening…"
            : integration.personalConnected
              ? "Reconnect GitHub account"
              : "Connect your GitHub account"}
        </Button>
        {integration.personalConnected && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={disconnect}>
            Disconnect account
          </Button>
        )}
      </div>
    </section>
  );
}
