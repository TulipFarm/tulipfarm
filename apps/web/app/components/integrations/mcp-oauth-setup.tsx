import type { McpAccountSummary, McpOAuthConfiguration } from "@tulipfarm/schema";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ApiError } from "~/lib/api";
import { copyText } from "~/lib/clipboard";
import { getMcpAccountOAuthConfiguration, startMcpAccountOAuth } from "~/lib/mcp-accounts";
import { McpError, McpField } from "./mcp-form";

export function McpOAuthSetup({
  account,
  onChanged,
}: {
  account: McpAccountSummary;
  onChanged: () => void;
}) {
  const [configuration, setConfiguration] = useState<McpOAuthConfiguration>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retrying must fetch fresh callback configuration.
  useEffect(() => {
    let live = true;
    setConfiguration(undefined);
    setError(undefined);
    setCopied(false);
    setLoading(true);
    getMcpAccountOAuthConfiguration(account.integrationKey, account.id)
      .then((next) => {
        if (live) setConfiguration(next);
      })
      .catch((cause) => {
        if (live) setError(cause);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [account.integrationKey, account.id, attempt]);

  return (
    <div className="space-y-3">
      <McpError error={error} />
      {loading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading OAuth callback URL...
        </p>
      )}
      {configuration && (
        <>
          <McpField
            label="OAuth callback URL"
            hint="For an existing OAuth app, register this exact allowed redirect URL with the provider before connecting."
          >
            <Input readOnly value={configuration.callbackUrl} />
          </McpField>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={async () => {
              setCopied(false);
              setError(undefined);
              if (await copyText(configuration.callbackUrl)) setCopied(true);
              else
                setError(
                  new Error("Could not copy the callback URL. Select and copy it manually.")
                );
            }}
          >
            Copy callback URL
          </Button>
          {copied && (
            <p role="status" className="text-xs text-muted-foreground">
              Callback URL copied.
            </p>
          )}
        </>
      )}
      {!loading && !configuration && (
        <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
          Retry callback URL
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={!configuration || pending}
        onClick={async () => {
          setPending(true);
          setError(undefined);
          try {
            await startMcpAccountOAuth(account.integrationKey, account.id);
            onChanged();
          } catch (cause) {
            if (cause instanceof ApiError && cause.code === "definition_changed")
              setConfiguration(undefined);
            setError(cause);
          } finally {
            setPending(false);
          }
        }}
      >
        {pending
          ? "Connecting..."
          : account.status === "pending"
            ? "Connect account"
            : "Sign in again"}
      </Button>
    </div>
  );
}
