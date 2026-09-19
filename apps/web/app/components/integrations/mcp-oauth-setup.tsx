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
  primary = false,
}: {
  account: McpAccountSummary;
  onChanged: () => void;
  primary?: boolean;
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

  const callbackFields = configuration && (
    <div className="space-y-2">
      <McpField
        label="OAuth callback URL"
        hint="Paste this exact URL into the allowed redirect or callback URL field in your provider's OAuth app settings, then save there."
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
          else setError(new Error("Could not copy the callback URL. Select and copy it manually."));
        }}
      >
        Copy callback URL
      </Button>
      {copied && (
        <p role="status" className="text-xs text-muted-foreground">
          Callback URL copied.
        </p>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      <McpError error={error} />
      {loading && (
        <p role="status" className="text-xs text-muted-foreground">
          Preparing provider sign-in...
        </p>
      )}
      {configuration &&
        (account.oauthClient ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">Finish setting up your provider app</p>
            <ol className="list-decimal space-y-2 pl-4 text-xs text-muted-foreground">
              <li>Copy the callback URL below.</li>
              <li>Register it in your provider's OAuth app settings and save your changes.</li>
              <li>
                Return here and choose{" "}
                {account.status === "pending" ? "Connect account" : "Sign in again"}.
              </li>
            </ol>
            {callbackFields}
          </div>
        ) : (
          <details className="space-y-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Advanced sign-in details
            </summary>
            {callbackFields}
          </details>
        ))}
      {!loading && !configuration && (
        <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
          Retry callback URL
        </Button>
      )}
      {account.status !== "pending" && (
        <p className="text-xs text-muted-foreground">
          Signing in again resets consent and access grants. Review affected Chats and Routines
          again.
        </p>
      )}
      <Button
        variant={primary ? "default" : "outline"}
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
