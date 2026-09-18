import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, MoreHorizontal, Trash2 } from "~/components/icons";
import { IntegrationAuthFlow, startHandoff } from "~/components/integrations/auth-flow";
import { ComingSoonState } from "~/components/integrations/coming-soon-state";
import { GitHubPersonalAccount } from "~/components/integrations/github-personal-account";
import { IntegrationIcon } from "~/components/integrations/integration-icon";
import { IntegrationOperations } from "~/components/integrations/integration-operations";
import { OimConnectionSetup } from "~/components/integrations/oim-connection-setup";
import { OimConnections } from "~/components/integrations/oim-connections";
import { MarkdownView } from "~/components/markdown-view";
import { ErrorState, NotFoundState } from "~/components/states";
import { StatusBadge } from "~/components/status-badge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { CopyField } from "~/components/ui/copy-field";
import { Link } from "~/components/ui/link";
import { Modal } from "~/components/ui/modal";
import { ApiError } from "~/lib/api";
import { connectionsPresentation, resolveConnectionSetupStates } from "~/lib/integration-status";
import {
  connectIntegration,
  deleteIntegration,
  disconnectGitHubInstallation,
  disconnectIntegration,
  type GitHubInstallation,
  getGitHubStatus,
  getInstalledOimRelease,
  getIntegration,
  getOimConnectionSetup,
  getOimReleaseUninstallStatus,
  type InstalledOimReleaseGeneration,
  type IntegrationDetail,
  type IntegrationGrant,
  listOimConnections,
  listSlackRoutes,
  type OimConnectionSetup as OimConnectionSetupModel,
  type OimConnectionSummary,
  type OimReleaseUninstallStatus,
  setOimAutoPatchPreference,
  uninstallOimRelease,
  updateIntegration,
} from "~/lib/integrations";
import { listTeams } from "~/lib/teams";
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

function isRecoverableSetupLookupError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof ApiError &&
      (error.status === 408 || error.status === 429 || error.status >= 500))
  );
}

export async function clientLoader({ params, request }: ClientLoaderFunctionArgs) {
  const name = params.name;
  if (!name) throw new ApiError(404, "missing integration name");
  const callbackConnectionId = new URL(request.url).searchParams.get("connection") || undefined;
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
  let oimConnections: OimConnectionSummary[] | undefined;
  let oimConnectionsError: string | undefined;
  let oimConnectionSetup: OimConnectionSetupModel | undefined;
  let oimConnectionSetupError: string | undefined;
  let oimRelease: InstalledOimReleaseGeneration | undefined;
  let oimReleaseError: string | undefined;
  let oimUninstallStatus: OimReleaseUninstallStatus | undefined;
  // Only an "oim" catalog entry has a Connection record to read — a legacy manifest-driven
  // Integration (Slack, GitHub) is not in the OIM package catalog and this route 404s for it
  // unconditionally, so sending it for every Integration just logs a background failure no UI
  // surfaces.
  if (integration.type === "oim") {
    try {
      oimConnections = await listOimConnections(name);
    } catch (error) {
      if (isRecoverableSetupLookupError(error)) {
        oimConnectionsError = errMessage(error);
      } else if (
        callbackConnectionId !== undefined ||
        !(error instanceof ApiError) ||
        error.status !== 404
      ) {
        throw error;
      }
    }
  }
  if (
    callbackConnectionId !== undefined ||
    oimConnections !== undefined ||
    oimConnectionsError !== undefined
  ) {
    try {
      oimConnectionSetup = await getOimConnectionSetup(name, callbackConnectionId);
    } catch (error) {
      if (isRecoverableSetupLookupError(error)) {
        oimConnectionSetupError = errMessage(error);
      } else if (
        callbackConnectionId === undefined &&
        oimConnectionsError === undefined &&
        error instanceof ApiError &&
        error.status === 404
      ) {
        oimConnections = undefined;
      } else {
        throw error;
      }
    }
  }
  if (oimConnectionSetup !== undefined) {
    const generation = {
      integrationId: oimConnectionSetup.integration.id,
      majorVersion: oimConnectionSetup.integration.majorVersion,
    };
    const pinnedInstallationId = new URL(request.url).searchParams.get("installation") || undefined;
    if (pinnedInstallationId !== undefined) {
      oimRelease = {
        ...generation,
        installationId: pinnedInstallationId,
        slug: name,
      };
    } else {
      try {
        const installed = await getInstalledOimRelease(
          generation.integrationId,
          generation.majorVersion
        );
        if (
          installed !== null &&
          installed.integrationId === generation.integrationId &&
          installed.majorVersion === generation.majorVersion &&
          installed.slug === name
        ) {
          oimRelease = installed;
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          oimRelease = undefined;
        } else if (isRecoverableSetupLookupError(error)) {
          oimReleaseError = errMessage(error);
        } else {
          throw error;
        }
      }
    }
    if (oimRelease !== undefined) {
      try {
        oimUninstallStatus = await getOimReleaseUninstallStatus(oimRelease);
      } catch (error) {
        if (isRecoverableSetupLookupError(error)) {
          oimReleaseError = errMessage(error);
        } else {
          throw error;
        }
      }
    }
  }
  const usesOimConnections =
    oimConnections !== undefined ||
    oimConnectionsError !== undefined ||
    oimConnectionSetup !== undefined ||
    oimConnectionSetupError !== undefined;
  let teams: { id: string; name: string }[] = [];
  let teamsError: string | undefined;
  if (usesOimConnections) {
    if (oimConnections) oimConnections = await resolveConnectionSetupStates(name, oimConnections);
    if (
      oimConnectionSetup?.allowedOwnerScopes.includes("team") ||
      oimConnections?.some((connection) => connection.owner.scope === "team")
    ) {
      try {
        teams = (await listTeams()).teams
          .filter((team) => team.status === "active")
          .map((team) => ({ id: team.id, name: `${team.displayName} — ${team.slug}` }));
      } catch (error) {
        teamsError = errMessage(error);
      }
    }
  }
  return {
    integration,
    routesError,
    githubInstallations,
    usesOimConnections,
    oimConnections,
    oimConnectionsError,
    oimConnectionSetup,
    oimConnectionSetupError,
    oimConnectionId: callbackConnectionId,
    oimRelease,
    oimReleaseError,
    oimUninstallStatus,
    teams,
    teamsError,
  };
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

function knowledgeSetupDraft(integration: IntegrationDetail): string {
  const sourceTools = integration.knowledge?.source_tools.join(", ") ?? "";
  const writeTools = integration.knowledge?.write_tools.join(", ") ?? "";
  return [
    `Set up ${displayName(integration)} as a Knowledge source.`,
    "Ask me which public channels, schedule, and summarization rules I want.",
    "Do not read messages or create anything until I approve the plan.",
    `Then create a durable Routine in the Soul using ${sourceTools} to read bounded pages and ${writeTools} to save reviewed content.`,
    "Store the newest processed Slack timestamp and pass it as oldest on the next Run. Use nextCursor only to finish the current bounded scan.",
    "Private channels and DMs must stay excluded.",
  ].join(" ");
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
  const {
    integration,
    routesError,
    githubInstallations,
    usesOimConnections,
    oimConnections,
    oimConnectionsError,
    oimConnectionSetup,
    oimConnectionSetupError,
    oimConnectionId,
    oimRelease,
    oimReleaseError,
    oimUninstallStatus: loadedOimUninstallStatus,
    teams,
    teamsError,
  } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectingInstallId, setDisconnectingInstallId] = useState<string>();
  const [addingInstall, setAddingInstall] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [oimUninstallStatus, setOimUninstallStatus] = useState(loadedOimUninstallStatus);
  const [autoPatchEnabled, setAutoPatchEnabled] = useState(oimRelease?.autoPatchOptIn ?? false);
  const [savingAutoPatch, setSavingAutoPatch] = useState(false);
  const [autoPatchStatus, setAutoPatchStatus] = useState("");
  const autoPatchGeneration = useRef(0);
  const [updating, setUpdating] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [callbackError, setCallbackError] = useState<string>();
  const [guideOpen, setGuideOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectStatus, setReconnectStatus] = useState("");

  const isAdmin = useIsAdmin();
  const selectedConnection = oimConnections?.find(
    (connection) => connection.id === oimConnectionId
  );
  const authSteps = (integration.auth ?? []).filter((step) => !step.personal);
  const connectionState = usesOimConnections ? connectionsPresentation(oimConnections) : undefined;
  const isConnected =
    connectionState?.usable ??
    (integration.connected && authSteps.every((step) => !step.producesEnv || step.satisfied));
  const installStep = authSteps.find((step) => step.kind === "install");
  const personalStep = integration.auth?.find((step) => step.personal);
  const personalStepReady =
    personalStep !== undefined &&
    (integration.auth ?? [])
      .filter((step) => step.index < personalStep.index && !step.personal)
      .every((step) => step.satisfied);
  const name = displayName(integration);
  const autoPatchScope = oimRelease
    ? `${oimRelease.integrationId}:${oimRelease.majorVersion}:${oimRelease.installationId}`
    : undefined;
  const autoPatchScopeRef = useRef(autoPatchScope);
  autoPatchScopeRef.current = autoPatchScope;

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
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("status");
    nextParams.delete("reason");
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams, revalidator]);

  useEffect(() => {
    setOimUninstallStatus(loadedOimUninstallStatus);
  }, [loadedOimUninstallStatus]);

  useEffect(() => {
    autoPatchGeneration.current += 1;
    autoPatchScopeRef.current = autoPatchScope;
    setAutoPatchEnabled(oimRelease?.autoPatchOptIn ?? false);
    setSavingAutoPatch(false);
    setAutoPatchStatus("");
  }, [autoPatchScope, oimRelease?.autoPatchOptIn]);

  async function handleAutoPatch(enabled: boolean) {
    if (oimRelease?.trustClass !== "official") return;
    const release = oimRelease;
    const scope = autoPatchScope;
    const request = ++autoPatchGeneration.current;
    setSavingAutoPatch(true);
    setActionError(undefined);
    try {
      const updated = await setOimAutoPatchPreference(
        release.integrationId,
        release.majorVersion,
        enabled
      );
      if (request !== autoPatchGeneration.current || scope !== autoPatchScopeRef.current) return;
      setAutoPatchEnabled(updated.autoPatchOptIn ?? enabled);
      setAutoPatchStatus(
        enabled
          ? "Automatic patch updates enabled for this Official package."
          : "Automatic patch updates disabled."
      );
    } catch (err) {
      if (request !== autoPatchGeneration.current || scope !== autoPatchScopeRef.current) return;
      setActionError(errMessage(err));
    } finally {
      if (request === autoPatchGeneration.current && scope === autoPatchScopeRef.current) {
        setSavingAutoPatch(false);
      }
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
    const release = oimRelease;
    try {
      if (release === undefined) {
        await deleteIntegration(integration.name);
      } else {
        if (searchParams.get("installation") !== release.installationId) {
          const nextParams = new URLSearchParams(searchParams);
          nextParams.set("installation", release.installationId);
          window.history.replaceState(
            window.history.state,
            "",
            `${window.location.pathname}?${nextParams.toString()}${window.location.hash}`
          );
        }
        await uninstallOimRelease(release);
      }
      window.location.href = "/integrations";
    } catch (err) {
      if (release !== undefined) {
        try {
          const status = await getOimReleaseUninstallStatus(release);
          setOimUninstallStatus(status);
          if (status.status === "pending") {
            setActionError(undefined);
            setDeleting(false);
            return;
          }
        } catch {
          // Keep the original uninstall error when its durable status is temporarily unavailable.
        }
      }
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
            {integration.updateAvailable && isAdmin && !usesOimConnections && (
              <Button size="sm" disabled={updating} onClick={handleUpdate}>
                {updating ? "Updating…" : "Update"}
              </Button>
            )}
            <StatusBadge
              label={connectionState?.label ?? (isConnected ? "Connected" : "Not connected")}
              tone={connectionState?.tone ?? (isConnected ? "success" : "neutral")}
            />
            {isAdmin && (!usesOimConnections || oimRelease !== undefined) && (
              <MoreMenu onDelete={handleDelete} deleting={deleting} />
            )}
          </div>
        </header>

        {integration.updateAvailable && !usesOimConnections && (
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
          <p role="alert" className="text-sm text-destructive">
            {integration.errorMessage}
          </p>
        )}

        {/* Connect, every step comes from the manifest, so there is nothing per-integration here. */}
        {!usesOimConnections && !isConnected && (
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
            ) : authSteps.some((step) => step.producesEnv) &&
              authSteps.every((step) => step.satisfied) ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Credentials are saved. Reconnect to activate this integration.
                </p>
                <Button
                  type="button"
                  disabled={reconnecting}
                  onClick={async () => {
                    setReconnecting(true);
                    setActionError(undefined);
                    setReconnectStatus("Reconnecting…");
                    try {
                      await connectIntegration(integration.name, {});
                      setReconnectStatus("Reconnect requested. Checking connection status.");
                      revalidator.revalidate();
                    } catch (error) {
                      setActionError(errMessage(error));
                      setReconnectStatus("Reconnect failed.");
                    } finally {
                      setReconnecting(false);
                    }
                  }}
                >
                  {reconnecting ? "Reconnecting…" : "Reconnect"}
                </Button>
                <p role="status" className="text-xs text-muted-foreground">
                  {reconnectStatus}
                </p>
              </div>
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

        {usesOimConnections && (
          <>
            {oimRelease?.trustClass === "official" ? (
              <section
                aria-labelledby="oim-auto-patch-heading"
                className="flex flex-col gap-2 rounded-md border border-border p-3"
              >
                <h2 id="oim-auto-patch-heading" className="text-sm font-medium text-foreground">
                  Official package updates
                </h2>
                <p className="text-xs text-muted-foreground">
                  Eligible patch releases must pass server-side signature verification against an
                  active public release trust root.
                </p>
                {isAdmin ? (
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={autoPatchEnabled}
                      disabled={savingAutoPatch}
                      onChange={(event) => void handleAutoPatch(event.target.checked)}
                    />
                    Automatically install verified patch releases
                  </label>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    An admin can change this package update preference.
                  </p>
                )}
                <p role="status" className="text-xs text-muted-foreground">
                  {savingAutoPatch ? "Saving package update preference…" : autoPatchStatus}
                </p>
              </section>
            ) : oimRelease?.trustClass === "community" ? (
              <section
                aria-labelledby="oim-community-updates-heading"
                className="rounded-md border border-border p-3"
              >
                <h2
                  id="oim-community-updates-heading"
                  className="text-sm font-medium text-foreground"
                >
                  Community package updates
                </h2>
                <p className="text-xs text-muted-foreground">
                  Automatic patches are disabled. Each Community package digest must be reviewed and
                  approved explicitly.
                </p>
              </section>
            ) : null}
            {oimUninstallStatus?.status === "pending" ? (
              <section
                aria-labelledby="oim-uninstall-heading"
                className="flex flex-col items-start gap-2 rounded-md border border-border p-3"
              >
                <h2 id="oim-uninstall-heading" className="text-sm font-medium text-foreground">
                  Removal needs another try
                </h2>
                <p role="status" className="text-xs text-muted-foreground">
                  {oimUninstallStatus.retryRequired
                    ? "Provider cleanup did not finish. Retry this exact installation."
                    : "Removal is waiting for provider cleanup. Retry this exact installation."}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={deleting}
                  onClick={() => void handleDelete()}
                >
                  {deleting ? "Retrying removal…" : "Retry removal"}
                </Button>
              </section>
            ) : null}
            {oimReleaseError ? (
              <p role="alert" className="text-sm text-destructive">
                {oimReleaseError}
              </p>
            ) : null}
            {callbackError ? (
              <p role="alert" className="text-sm text-destructive">
                {callbackError}
              </p>
            ) : null}
            {oimConnectionSetup !== undefined || oimConnectionSetupError !== undefined ? (
              <OimConnectionSetup
                key={integration.name}
                integrationKey={integration.name}
                setup={oimConnectionSetup}
                setupError={oimConnectionSetupError}
                connectionId={oimConnectionId}
                connectionLabel={selectedConnection?.label}
                unavailable={
                  selectedConnection?.disconnectPending
                    ? "This Connection is disconnecting and cannot be used or edited."
                    : selectedConnection?.status === "revoked"
                      ? "This Connection is revoked."
                      : undefined
                }
                teams={teams}
                teamsError={teamsError}
                onAddAnother={
                  oimConnectionId
                    ? () => {
                        const nextParams = new URLSearchParams(searchParams);
                        nextParams.delete("connection");
                        nextParams.delete("status");
                        nextParams.delete("reason");
                        setSearchParams(nextParams);
                      }
                    : undefined
                }
                onConnectionSelected={(connectionId) => {
                  const nextParams = new URLSearchParams(searchParams);
                  nextParams.set("connection", connectionId);
                  nextParams.delete("status");
                  nextParams.delete("reason");
                  setSearchParams(nextParams, { replace: true });
                }}
                onChanged={() => revalidator.revalidate()}
              />
            ) : null}
            {teamsError ? (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-destructive">
                  Teams could not load: {teamsError}
                </p>
                <Button type="button" variant="outline" onClick={() => revalidator.revalidate()}>
                  Retry Teams
                </Button>
              </div>
            ) : null}
            {oimConnections ? (
              <OimConnections
                integrationKey={integration.name}
                connections={oimConnections}
                teams={teams}
                onResume={(connectionId) => {
                  const nextParams = new URLSearchParams(searchParams);
                  nextParams.set("connection", connectionId);
                  nextParams.delete("status");
                  nextParams.delete("reason");
                  setSearchParams(nextParams);
                }}
                onChanged={() => revalidator.revalidate()}
              />
            ) : oimConnectionsError ? (
              <section className="flex flex-col items-start gap-2">
                <p role="alert" className="text-sm text-destructive">
                  {oimConnectionsError}
                </p>
                <Button type="button" variant="outline" onClick={() => revalidator.revalidate()}>
                  Retry Connections
                </Button>
              </section>
            ) : null}
            <IntegrationOperations
              key={`operations:${integration.name}`}
              integrationKey={integration.name}
            />
          </>
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

        {integration.knowledge && (
          <section className="flex flex-col gap-2">
            <SectionHeading>Knowledge</SectionHeading>
            <p className="max-w-prose text-sm text-foreground">
              {isConnected
                ? `${name} is authorized for user-configured Knowledge setup.`
                : `Connect ${name} before setting it up as a Knowledge source.`}
            </p>
            <p className="max-w-prose text-xs text-muted-foreground">
              Nothing is indexed automatically. The setup flow creates a Soul-backed Routine only
              after you choose public channels, a schedule, and what should become Knowledge.
              Private channels and DMs are refused.
            </p>
            {isConnected && (
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <Link to={`/?draft=${encodeURIComponent(knowledgeSetupDraft(integration))}`}>
                    Set up in Chat
                  </Link>
                </Button>
                {integration.setupGuide && (
                  <Button size="sm" variant="outline" onClick={() => setGuideOpen(true)}>
                    View setup guide
                  </Button>
                )}
              </div>
            )}
          </section>
        )}

        {!usesOimConnections && integration.name === "github" && personalStepReady && (
          <GitHubPersonalAccount
            integration={integration}
            callbackError={callbackError}
            onChanged={() => revalidator.revalidate()}
          />
        )}

        {/* Where the GitHub App currently reaches. Provider-shaped state, not part of connecting. */}
        {!usesOimConnections && integration.name === "github" && isConnected && (
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
        {!usesOimConnections && integration.name === "slack" && isConnected && (
          <section className="flex flex-col gap-2">
            <SectionHeading>Routing</SectionHeading>
            {routesError ? (
              <>
                <p role="alert" className="text-sm text-destructive">
                  Couldn't confirm channel routing: {routesError}
                </p>
                <p className="max-w-prose text-xs text-muted-foreground">
                  This usually means the stored Slack bot token is invalid or was revoked.
                  Disconnect and reconnect to run the install step again and mint a fresh one.
                </p>
              </>
            ) : (
              <p className="max-w-prose text-xs text-muted-foreground">
                Linked senders can use 1:1 DMs, app mentions, and replies in threads where the app
                was mentioned. Ordinary channel messages and bot or metadata events are ignored. The
                highest-priority matching route selects the Agent; otherwise the default assistant
                handles the message.
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

        {actionError && (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        )}

        {!usesOimConnections && isConnected && isAdmin && (
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
