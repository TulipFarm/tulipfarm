import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "@remix-run/react";
import { ArrowLeft, ExternalLink, MoreHorizontal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IntegrationAuthFlow, startHandoff } from "~/components/integrations/auth-flow";
import { ComingSoonState } from "~/components/integrations/coming-soon-state";
import { GitHubPersonalAccount } from "~/components/integrations/github-personal-account";
import { IntegrationIcon } from "~/components/integrations/integration-icon";
import { MarkdownView } from "~/components/markdown-view";
import { ErrorState, NotFoundState } from "~/components/states";
import { StatusBadge } from "~/components/status-badge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { CopyField } from "~/components/ui/copy-field";
import { Link } from "~/components/ui/link";
import { Modal } from "~/components/ui/modal";
import { ApiError } from "~/lib/api";
import {
  deleteIntegration,
  disconnectGitHubInstallation,
  disconnectIntegration,
  type GitHubInstallation,
  getGitHubStatus,
  getIntegration,
  type IntegrationDetail,
  type IntegrationGrant,
  listSlackRoutes,
  updateIntegration,
} from "~/lib/integrations";
import { useIsAdmin } from "~/lib/use-session-user";

export const meta: MetaFunction = () => [{ title: "Integration · tulipfarm" }];

/**
 * A registry entry that is listed but not opened yet. Thrown rather than rendered so the page
 * never mounts a connect flow this deployment will not honor, however the URL was reached.
 */
class ComingSoonError extends Error {
  constructor(readonly integrationName: string) {
    super(`integration not available yet: ${integrationName}`);
  }
}

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const name = params.name;
  if (!name) throw new ApiError(404, "missing integration name");
  const integration = await getIntegration(name);
  if (integration.availability === "coming_soon") {
    throw new ComingSoonError(integration.title ?? integration.name);
  }
  let routesError: string | undefined;
  if (name === "slack" && integration.connected) {
    try {
      // listSlackRoutes round-trips through Slack's auth.test — reused here purely to verify the
      // stored bot token still works, surfaced as a routing status banner. A bad token must not
      // take down the whole page — the rest of the integration detail should still render.
      await listSlackRoutes();
    } catch (err) {
      routesError = errMessage(err);
    }
  }
  // Which accounts and repositories the App is installed on is GitHub-shaped state held in the
  // API's own store, not connection env — the declarative auth flow above establishes the
  // credential, this reports what that credential currently reaches.
  let githubInstallations: GitHubInstallation[] = [];
  if (name === "github") {
    try {
      githubInstallations = await getGitHubStatus();
    } catch (err) {
      routesError = errMessage(err);
    }
  }
  return { integration, routesError, githubInstallations };
}

/* Redirect error codes are the closed set in `AuthBrokerError`. */
const CALLBACK_REASON: Record<string, string> = {
  unknown_step: "That setup step no longer exists. Reload the page and start again.",
  invalid_state: "This setup link expired or was already used. Start the step again.",
  missing_credentials:
    "An earlier setup step is missing its credentials. Complete that step first.",
  exchange_failed: "The provider rejected the request. Start the step again.",
};

function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : "request failed";
}

function displayName(integration: IntegrationDetail): string {
  return integration.title ?? integration.name;
}

// Separators are decoration, and at narrow widths a wrapped line strands one at the end of the
// row above. Below `sm` they are dropped and the gap widens instead, so the meta line still reads
// as distinct items without the orphan.
function Dot() {
  return (
    <span aria-hidden className="hidden opacity-40 sm:inline">
      ·
    </span>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-foreground">{children}</h2>;
}

/** Keep consent visible after connection for audits. */
function GrantList({ grants }: { grants: IntegrationGrant[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
      {grants.map((grant) => (
        <li
          key={`${grant.label}:${grant.access ?? ""}`}
          className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3"
        >
          {/* Fixed columns keep scope/access comparisons aligned; rows stack below `sm`. */}
          <span className="flex items-center gap-2 sm:contents">
            <code className="text-xs text-foreground sm:w-40 sm:shrink-0 sm:truncate">
              {grant.label}
            </code>
            <span className="sm:w-14 sm:shrink-0">
              {grant.access && <Badge className="capitalize">{grant.access}</Badge>}
            </span>
          </span>
          {grant.description && (
            <span className="text-xs text-muted-foreground">{grant.description}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

// Removing an integration is rare, irreversible-ish, and shares a page with the setup flow, so it
// lives behind `⋯` with a two-step confirm rather than in a permanent red panel — the old page
// shouted "danger zone" at everyone who came to connect. Mirrors knowledge/page-detail.tsx.
function MoreMenu({ onDelete, deleting }: { onDelete: () => void; deleting: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setConfirming(false);
    };
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const itemClass =
    "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm disabled:cursor-default disabled:opacity-50";

  return (
    <div ref={ref} className="relative">
      <Button
        variant="outline"
        size="icon"
        className="size-8 cursor-pointer"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal aria-hidden />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 flex min-w-56 flex-col gap-0.5 rounded-sm border border-border bg-card p-1 shadow-md"
        >
          {confirming ? (
            <>
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                Removes it from the soul repo and disconnects it first.
              </p>
              <button
                type="button"
                role="menuitem"
                disabled={deleting}
                onClick={onDelete}
                className={`${itemClass} text-destructive hover:bg-destructive/10`}
              >
                <Trash2 className="size-4" aria-hidden />
                {deleting ? "Removing…" : "Confirm remove"}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={deleting}
                onClick={() => setConfirming(false)}
                className={`${itemClass} text-muted-foreground hover:bg-accent`}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => setConfirming(true)}
              className={`${itemClass} text-destructive hover:bg-destructive/10`}
            >
              <Trash2 className="size-4" aria-hidden />
              Remove integration
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function IntegrationDetailPage() {
  const { integration, routesError, githubInstallations } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectingInstallId, setDisconnectingInstallId] = useState<string>();
  const [addingInstall, setAddingInstall] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [callbackError, setCallbackError] = useState<string>();
  const [guideOpen, setGuideOpen] = useState(false);

  const isAdmin = useIsAdmin();
  const authSteps = (integration.auth ?? []).filter((step) => !step.personal);
  const isConnected = integration.connected;
  const installStep = authSteps.find((step) => step.kind === "install");
  const personalStep = integration.auth?.find((step) => step.personal);
  const personalStepReady =
    personalStep !== undefined &&
    (integration.auth ?? [])
      .filter((step) => step.index < personalStep.index && !step.personal)
      .every((step) => step.satisfied);
  const name = displayName(integration);

  // The single auth callback returns here with the outcome of the step the operator just left for.
  useEffect(() => {
    const status = searchParams.get("status");
    if (!status) return;
    if (status === "error") {
      const reason = searchParams.get("reason") ?? "";
      setCallbackError(CALLBACK_REASON[reason] ?? "That setup step did not complete.");
    } else {
      setCallbackError(undefined);
      revalidator.revalidate();
    }
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams, revalidator]);

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

  async function handleDisconnectInstallation(installationId: string) {
    setDisconnectingInstallId(installationId);
    setActionError(undefined);
    try {
      await disconnectGitHubInstallation(installationId);
      revalidator.revalidate();
    } catch (err) {
      setActionError(errMessage(err));
    } finally {
      setDisconnectingInstallId(undefined);
    }
  }

  async function handleAddInstall() {
    if (!installStep) return;
    setAddingInstall(true);
    setActionError(undefined);
    try {
      const outcome = await startHandoff(integration.name, installStep.index);
      if (outcome === "completed") {
        revalidator.revalidate();
        setAddingInstall(false);
      }
    } catch (err) {
      setActionError(errMessage(err));
      setAddingInstall(false);
    }
  }

  async function handleUpdate() {
    setUpdating(true);
    setActionError(undefined);
    try {
      await updateIntegration(integration.name, integration.source);
      revalidator.revalidate();
    } catch (err) {
      setActionError(errMessage(err));
    } finally {
      setUpdating(false);
    }
  }

  async function handleDelete() {
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

  return (
    <>
      {/* The top bar names the section, not this integration, so the way back to the catalog has
          to live on the page. */}
      <Link
        to="/integrations"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Integrations
      </Link>
      <div className="flex flex-col gap-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <IntegrationIcon
              label={name}
              iconSlug={integration.iconSlug}
              iconPath={integration.iconPath}
              iconColor={integration.iconColor}
              size="lg"
            />
            <div className="flex min-w-0 flex-col gap-1.5">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">{name}</h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground sm:gap-x-2.5">
                {/* The slug is what every URL, log line, and manifest calls it, so it stays
                    visible even once the brand name is the headline. */}
                <code>{integration.name}</code>
                {integration.category && (
                  <>
                    <Dot />
                    <span className="capitalize">{integration.category}</span>
                  </>
                )}
                {integration.version && (
                  <>
                    <Dot />
                    <span>v{integration.version}</span>
                  </>
                )}
                {integration.maintainer && (
                  <>
                    <Dot />
                    <span>by {integration.maintainer}</span>
                  </>
                )}
                {integration.homepage && (
                  <>
                    <Dot />
                    <a
                      href={integration.homepage}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline underline-offset-2 hover:opacity-80"
                    >
                      Website
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {integration.updateAvailable && isAdmin && (
              <Button size="sm" disabled={updating} onClick={handleUpdate}>
                {updating ? "Updating…" : "Update"}
              </Button>
            )}
            <StatusBadge
              label={isConnected ? "Connected" : "Not connected"}
              tone={isConnected ? "success" : "neutral"}
            />
            {isAdmin && <MoreMenu onDelete={handleDelete} deleting={deleting} />}
          </div>
        </header>

        {integration.updateAvailable && (
          <div className="flex flex-col gap-3 rounded-sm border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">Update available</span>
              <span className="text-xs text-muted-foreground">
                A newer version of this integration is available from its source repository.
              </span>
            </div>
            {isAdmin && (
              <Button
                size="sm"
                disabled={updating}
                onClick={handleUpdate}
                className="self-start sm:self-auto"
              >
                {updating ? "Updating…" : "Update now"}
              </Button>
            )}
          </div>
        )}

        {integration.description && (
          <p className="max-w-prose text-sm text-muted-foreground">{integration.description}</p>
        )}

        {integration.errorMessage && (
          <p className="text-sm text-destructive">{integration.errorMessage}</p>
        )}

        {/* Connect, every step comes from the manifest, so there is nothing per-integration here. */}
        {!isConnected && (
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <SectionHeading>Connect</SectionHeading>
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
            {authSteps.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                This integration declares no credentials. Nothing to set up.
              </p>
            ) : !isAdmin ? (
              <p className="max-w-prose text-xs text-muted-foreground">
                Connecting seals the credential every agent in this workspace spends, so an admin
                has to do it. Ask one to connect {name}.
              </p>
            ) : (
              <IntegrationAuthFlow
                slug={integration.name}
                providerLabel={name}
                steps={authSteps}
                onAdvance={() => revalidator.revalidate()}
                calloutError={callbackError}
              />
            )}
          </section>
        )}

        {integration.capabilities && integration.capabilities.length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionHeading>What agents can do</SectionHeading>
            <ul className="flex flex-col gap-1.5">
              {integration.capabilities.map((capability) => (
                <li key={capability} className="flex gap-2 text-sm text-foreground">
                  <span aria-hidden className="text-muted-foreground">
                    -
                  </span>
                  <span>{capability}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {integration.grants.length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionHeading>Access you grant</SectionHeading>
            <p className="max-w-prose text-xs text-muted-foreground">
              {isConnected
                ? "What this integration can reach today."
                : "What connecting asks the provider for. These are the provider's own terms. They should match what its consent screen shows you."}
            </p>
            <GrantList grants={integration.grants} />
          </section>
        )}

        {integration.name === "github" && personalStepReady && (
          <GitHubPersonalAccount
            integration={integration}
            callbackError={callbackError}
            onChanged={() => revalidator.revalidate()}
          />
        )}

        {/* Where the GitHub App currently reaches. Provider-shaped state, not part of connecting. */}
        {integration.name === "github" && isConnected && (
          <section className="flex flex-col gap-2">
            <SectionHeading>Installations</SectionHeading>
            {routesError && <p className="text-sm text-destructive">{routesError}</p>}
            {githubInstallations.length === 0 && !routesError && (
              <p className="text-xs text-muted-foreground">
                The App is not installed on any account yet.
              </p>
            )}
            {githubInstallations.length > 0 && (
              <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
                {githubInstallations.map((install) => (
                  <li
                    key={install.installationId}
                    className="flex items-center justify-between gap-3 px-3 py-2.5"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {install.account}
                      </span>
                      <span className="line-clamp-1 text-xs text-muted-foreground">
                        {install.repositories.length === 0
                          ? "No repositories yet"
                          : `${install.repositories.length} repo${install.repositories.length === 1 ? "" : "s"}: ${install.repositories.join(", ")}`}
                      </span>
                    </div>
                    {isAdmin && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disconnectingInstallId === install.installationId}
                        onClick={() => handleDisconnectInstallation(install.installationId)}
                      >
                        {disconnectingInstallId === install.installationId
                          ? "Disconnecting…"
                          : "Disconnect"}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-3">
              {installStep && isAdmin && (
                <Button size="sm" disabled={addingInstall} onClick={handleAddInstall}>
                  {addingInstall ? "Opening…" : "Add another install"}
                </Button>
              )}
              <a
                href="https://github.com/settings/installations"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2 hover:opacity-80"
              >
                Manage repos on GitHub
                <ExternalLink className="size-3" aria-hidden />
              </a>
            </div>
          </section>
        )}

        {/* Slack routing status */}
        {integration.name === "slack" && isConnected && (
          <section className="flex flex-col gap-2">
            <SectionHeading>Routing</SectionHeading>
            {routesError ? (
              <>
                <p className="text-sm text-destructive">
                  Couldn't confirm channel routing: {routesError}
                </p>
                <p className="max-w-prose text-xs text-muted-foreground">
                  This usually means the stored Slack bot token is invalid or was revoked.
                  Disconnect and reconnect to run the install step again and mint a fresh one.
                </p>
              </>
            ) : (
              <p className="max-w-prose text-xs text-muted-foreground">
                All Slack DMs and channel messages go to the default TulipFarm assistant.
              </p>
            )}
          </section>
        )}

        {/* Inbound webhook URL (integrations that declare ingress, e.g. Slack events) */}
        {integration.ingress?.enabled && integration.ingress.webhookUrl && (
          <section className="flex flex-col gap-2">
            <SectionHeading>Webhook URL</SectionHeading>
            <p className="max-w-prose text-xs text-muted-foreground">
              Paste this into the provider's event subscription settings (Slack: Event Subscriptions
              → Request URL). Connect the integration first, the URL only verifies once a signing
              secret is saved.
            </p>
            <CopyField value={integration.ingress.webhookUrl} label="webhook URL" />
          </section>
        )}

        {actionError && <p className="text-sm text-destructive">{actionError}</p>}

        {isConnected && isAdmin && (
          <section className="flex flex-col gap-2 border-t border-border pt-5">
            <SectionHeading>Connection</SectionHeading>
            <p className="max-w-prose text-xs text-muted-foreground">
              Stored credentials are kept, so reconnecting does not repeat setup.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={disconnecting}
              onClick={handleDisconnect}
            >
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </Button>
          </section>
        )}
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
    </>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (error instanceof ComingSoonError) {
    return <ComingSoonState name={error.integrationName} />;
  }
  if (error instanceof ApiError && error.status === 404) {
    return <NotFoundState section="integrations" />;
  }
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="integrations" status={status} message={message} />;
}
