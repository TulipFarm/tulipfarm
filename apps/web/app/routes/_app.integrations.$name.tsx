import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "@remix-run/react";
import { useEffect, useState } from "react";
import { MarkdownView } from "~/components/markdown-view";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Modal } from "~/components/ui/modal";
import { ApiError } from "~/lib/api";
import {
  connectIntegration,
  deleteIntegration,
  disconnectIntegration,
  getIntegration,
  type McpConnectionStatus,
  startOAuth,
} from "~/lib/integrations";

export const meta: MetaFunction = () => [{ title: "Integration · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const name = params.name;
  if (!name) throw new ApiError(404, "missing integration name");
  const integration = await getIntegration(name);
  return { integration };
}

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

const STATUS_LABEL: Record<McpConnectionStatus, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  error: "Error",
  disconnected: "Not connected",
};

const STATUS_CLASS: Record<McpConnectionStatus, string> = {
  connected: "text-muted-foreground",
  connecting: "text-primary",
  error: "text-destructive",
  disconnected: "text-muted-foreground",
};

function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : "request failed";
}

export default function IntegrationDetailPage() {
  const { integration } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  const requiredEnv = integration.manifest.required_env ?? [];
  const [envValues, setEnvValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(requiredEnv.map((e) => [e.name, ""]))
  );
  const [connecting, setConnecting] = useState(false);
  const [oauthPending, setOauthPending] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [guideOpen, setGuideOpen] = useState(false);

  // Handle OAuth callback redirect: ?connected=true or ?error=...
  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");
    if (connected === "true") {
      setOauthPending(false);
      setSearchParams({}, { replace: true });
      revalidator.revalidate();
    } else if (error) {
      setOauthPending(false);
      setActionError(decodeURIComponent(error));
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, revalidator]);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setConnecting(true);
    setActionError(undefined);
    try {
      await connectIntegration(integration.name, envValues);
      revalidator.revalidate();
    } catch (err) {
      setActionError(errMessage(err));
    } finally {
      setConnecting(false);
    }
  }

  async function handleOAuth() {
    setActionError(undefined);
    setOauthPending(true);
    try {
      const { authUrl } = await startOAuth(integration.name, envValues);
      window.open(authUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setActionError(errMessage(err));
      setOauthPending(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setActionError(undefined);
    try {
      await disconnectIntegration(integration.name);
      revalidator.revalidate();
    } catch (err) {
      setActionError(errMessage(err));
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Remove integration "${integration.name}"?`)) return;
    setDeleting(true);
    setActionError(undefined);
    try {
      await deleteIntegration(integration.name);
      window.location.href = "/integrations";
    } catch (err) {
      setActionError(errMessage(err));
      setDeleting(false);
    }
  }

  const isConnected = integration.status === "connected";
  const entry = integration.manifest.entry as Record<string, unknown>;
  const oauthConfig = integration.manifest.oauth;

  return (
    <ResourcePanel
      crumbs={[{ label: "integrations", to: "/integrations" }, { label: integration.name }]}
    >
      <div className="flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold text-foreground">{integration.name}</h1>
            {integration.description && (
              <p className="text-sm text-muted-foreground">{integration.description}</p>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className={`text-sm ${STATUS_CLASS[integration.status]}`}>
              {STATUS_LABEL[integration.status]}
            </span>
            {integration.errorMessage && (
              <span className="text-xs text-destructive">{integration.errorMessage}</span>
            )}
          </div>
        </div>

        {/* Manifest details */}
        <div className="flex flex-col gap-1 rounded-sm border border-border p-3 text-sm">
          <div className="flex gap-2">
            <span className="w-24 text-muted-foreground">type</span>
            <span className="text-foreground">{integration.type}</span>
          </div>
          {integration.version && (
            <div className="flex gap-2">
              <span className="w-24 text-muted-foreground">version</span>
              <span className="text-foreground">{integration.version}</span>
            </div>
          )}
          {integration.maintainer && (
            <div className="flex gap-2">
              <span className="w-24 text-muted-foreground">maintainer</span>
              <span className="text-foreground">{integration.maintainer}</span>
            </div>
          )}
          {typeof entry.transport === "string" && (
            <div className="flex gap-2">
              <span className="w-24 text-muted-foreground">transport</span>
              <span className="text-foreground">{entry.transport}</span>
            </div>
          )}
        </div>

        {/* Connect form (only when not connected) */}
        {!isConnected && (
          <form onSubmit={handleConnect} className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium text-foreground">Connect</h2>
              {integration.setupGuide && (
                <button
                  type="button"
                  onClick={() => setGuideOpen(true)}
                  className="text-xs text-primary underline underline-offset-2 hover:opacity-80"
                >
                  Setup guide →
                </button>
              )}
            </div>
            {requiredEnv.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No configuration required. Click Connect to start the MCP server.
              </p>
            ) : (
              requiredEnv.map((field) => (
                <div key={field.name} className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-foreground" htmlFor={field.name}>
                    {field.label}
                    {field.description && (
                      <span className="ml-1 font-normal text-muted-foreground">
                        — {field.description}
                      </span>
                    )}
                  </label>
                  <input
                    id={field.name}
                    className={inputClass}
                    type={field.secret ? "password" : "text"}
                    placeholder={field.name}
                    value={envValues[field.name] ?? ""}
                    onChange={(e) =>
                      setEnvValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                    }
                    autoComplete={field.secret ? "off" : undefined}
                  />
                  {(field.steps?.length || field.setup_url) && (
                    <details className="mt-0.5">
                      <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
                        How to get this
                      </summary>
                      <div className="mt-1.5 flex flex-col gap-1 pl-3 text-xs text-muted-foreground">
                        {field.steps?.map((step, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: static ordered list
                          <p key={i}>
                            {i + 1}. {step}
                          </p>
                        ))}
                        {field.setup_url && (
                          <a
                            href={field.setup_url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-0.5 text-primary underline underline-offset-2 hover:opacity-80"
                          >
                            Open docs →
                          </a>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              ))
            )}
            {actionError && <p className="text-sm text-destructive">{actionError}</p>}
            {oauthPending && (
              <p className="text-xs text-muted-foreground">
                Waiting for authorization in the new tab…
              </p>
            )}
            <div className="flex gap-2">
              {oauthConfig && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={oauthPending || connecting}
                  onClick={handleOAuth}
                >
                  {oauthPending ? "Authorizing…" : "Connect with OAuth"}
                </Button>
              )}
              <Button type="submit" size="sm" disabled={connecting || oauthPending}>
                {connecting ? "Connecting…" : "Connect"}
              </Button>
            </div>
          </form>
        )}

        {/* Disconnect */}
        {isConnected && (
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-foreground">Connection</h2>
            <p className="text-xs text-muted-foreground">
              MCP server is running. Disconnect to stop it.
            </p>
            {actionError && <p className="text-sm text-destructive">{actionError}</p>}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={disconnecting}
                onClick={handleDisconnect}
              >
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </Button>
            </div>
          </div>
        )}

        {/* Danger zone */}
        <div className="flex flex-col gap-2 rounded-sm border border-destructive/30 p-3">
          <h2 className="text-sm font-medium text-destructive">Remove</h2>
          <p className="text-xs text-muted-foreground">
            Removes the integration from the soul repo. Disconnects first if connected.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="self-start border-destructive text-destructive hover:bg-destructive/10"
            disabled={deleting}
            onClick={handleDelete}
          >
            {deleting ? "Removing…" : "Remove integration"}
          </Button>
        </div>
      </div>

      {/* Setup guide modal */}
      {integration.setupGuide && (
        <Modal
          open={guideOpen}
          onClose={() => setGuideOpen(false)}
          title="Setup guide"
          className="max-w-2xl"
        >
          <div className="max-h-[70vh] overflow-y-auto">
            <MarkdownView>{integration.setupGuide}</MarkdownView>
          </div>
        </Modal>
      )}
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="integrations" status={status} message={message} />;
}
