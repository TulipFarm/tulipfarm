import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { RefreshCw, ShieldAlert } from "~/components/icons";
import { KillSwitchPanel } from "~/components/kill-switches/kill-switch-panel";
import {
  type OperationAction,
  OperationsConsole,
} from "~/components/operations/operations-console";
import { PageShell } from "~/components/page-shell";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { describeScope, getKillSwitches, type KillSwitchModel } from "~/lib/kill-switches";
import { commandOperation, getOperations } from "~/lib/operations";
import { useIsAdmin } from "~/lib/use-session-user";

export async function clientLoader() {
  // Arming a stop is admin-only while the console itself is not, so a non-admin gets no panel
  // rather than a page that fails to load.
  const [model, safety] = await Promise.all([
    getOperations(),
    getKillSwitches()
      .then((killSwitches) => ({ killSwitches, killSwitchError: false }))
      .catch((error) => ({
        killSwitches: null as KillSwitchModel | null,
        killSwitchError: !(error instanceof ApiError && [401, 403].includes(error.status)),
      })),
  ]);
  return { model, ...safety };
}

export default function OperationsRoute() {
  const { model, killSwitches, killSwitchError } = useLoaderData<typeof clientLoader>();
  const isAdmin = useIsAdmin();
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const refreshing = revalidator.state !== "idle";
  const activeStops = isAdmin
    ? (killSwitches?.killSwitches.filter((item) => item.enabled) ?? [])
    : [];
  async function command(action: OperationAction, input: Record<string, unknown>) {
    setBusy(true);
    try {
      await commandOperation(action, input);
      revalidator.revalidate();
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageShell
      title="Operations"
      actions={
        <Button disabled={busy || refreshing} onClick={() => revalidator.revalidate()}>
          <RefreshCw aria-hidden="true" className="size-4" />
          {refreshing ? "Refreshing status…" : "Refresh status"}
        </Button>
      }
    >
      <p role="status" className="sr-only">
        {refreshing ? "Refreshing status. Last reported health remains visible." : ""}
      </p>
      {activeStops.length > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-start gap-3 rounded-md border border-status-danger/40 bg-card p-4"
        >
          <ShieldAlert aria-hidden="true" className="size-4 shrink-0 text-status-danger" />
          <div className="min-w-0 flex-1 basis-48">
            <p className="text-sm font-medium text-status-danger">
              {activeStops.length} active emergency {activeStops.length === 1 ? "stop" : "stops"}
            </p>
            <ul className="mt-1 space-y-1 break-words text-sm">
              {activeStops.map((stop) => (
                <li key={stop.id}>{describeScope(stop)}</li>
              ))}
            </ul>
          </div>
          <a
            href="#operations-emergency-stop"
            className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
          >
            Review emergency stop
          </a>
        </div>
      ) : null}
      {isAdmin && killSwitchError ? (
        <p role="alert" className="rounded-md border border-border bg-card p-4 text-sm">
          Emergency stop status is unavailable. Active stops could not be checked. Refresh status to
          try again.
        </p>
      ) : null}
      <OperationsConsole
        model={model}
        busy={busy || refreshing}
        onCommand={command}
        safety={
          isAdmin && killSwitches ? (
            <KillSwitchPanel model={killSwitches} onChanged={() => revalidator.revalidate()} />
          ) : null
        }
      />
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const forbidden = error instanceof ApiError && [401, 403].includes(error.status);
  return (
    <PageShell title="Operations">
      <section className="max-w-prose space-y-3">
        <h2 className="text-lg font-medium">
          {forbidden ? "Operations access is unavailable" : "Operations are unavailable"}
        </h2>
        <p role="alert" className="break-words text-sm">
          {error instanceof Error ? error.message : "Could not load Operations."}
        </p>
        <p className="text-sm text-muted-foreground">
          {forbidden
            ? "Your current session cannot read Operations. Check your access, then try again."
            : "Health and emergency stop status could not be checked. Try again to get the latest report."}
        </p>
        <Button disabled={revalidator.state !== "idle"} onClick={() => revalidator.revalidate()}>
          {revalidator.state === "idle" ? "Try again" : "Trying again…"}
        </Button>
      </section>
    </PageShell>
  );
}
