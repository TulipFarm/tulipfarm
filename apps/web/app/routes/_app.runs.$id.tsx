import {
  type ClientLoaderFunctionArgs,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { PageShell } from "~/components/page-shell";
import { RunBudgets, type RunBudgetsState } from "~/components/runs/run-budgets";
import { RunInspector } from "~/components/runs/run-inspector";
import { ConnectionStatus } from "~/components/shell/states";
import { ErrorState } from "~/components/states";
import { API_BASE, ApiError } from "~/lib/api";
import {
  commandRun,
  getOperationalRun,
  getRunBudgets,
  type OperationalRun,
  type RunCommandAction,
} from "~/lib/operations";

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  if (!params.id) throw new ApiError(404, "Run not found");
  return { run: await getOperationalRun(params.id) };
}

export default function OperationalRunRoute() {
  const { run } = useLoaderData<typeof clientLoader>();
  return <RunDetail key={run.id} run={run} />;
}

function RunDetail({ run }: { run: OperationalRun }) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState<string>();
  const [commandError, setCommandError] = useState<string>();
  const [connection, setConnection] = useState<"online" | "reconnecting">("online");
  const [budgets, setBudgets] = useState<RunBudgetsState>({ status: "loading" });
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setBudgets({ status: "loading" });
    getRunBudgets(run.id)
      .then((result) => {
        if (active) setBudgets({ status: "loaded", budgets: result.budgets });
      })
      .catch((error) => {
        if (active) {
          setBudgets({
            status: "error",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [run.id]);

  useEffect(() => {
    setConnection("online");
    if (["succeeded", "failed", "cancelled"].includes(run.status)) return;
    const key = `run-cursor:${run.id}`;
    const after = sessionStorage.getItem(key) ?? "0";
    const source = new EventSource(
      `${API_BASE}/api/v1/runs/${encodeURIComponent(run.id)}/events?after=${after}`,
      { withCredentials: true }
    );
    const onEvent = (event: MessageEvent) => {
      if (event.lastEventId) sessionStorage.setItem(key, event.lastEventId);
      setConnection("online");
      revalidator.revalidate();
    };
    for (const eventType of [
      "state.completed",
      "effect.updated",
      "run.waiting",
      "run.attention_required",
      "stream.closed",
    ]) {
      source.addEventListener(eventType, onEvent);
    }
    source.onerror = () => setConnection("reconnecting");
    return () => source.close();
  }, [revalidator, run.id, run.status]);

  async function submit(action: RunCommandAction) {
    if (busy || unavailable || !run.availableCommands?.includes(action)) return;
    setBusy(true);
    setCommandError(undefined);
    try {
      await commandRun(run, action, `Operator requested ${action} from the Run inspector`);
      if (active.current) revalidator.revalidate();
    } catch (error) {
      // 501 means this deployment has no authority for the command at all, not that this attempt
      // failed. Lock the controls and repeat the server's reason instead of inviting a retry.
      if (!active.current) return;
      if (error instanceof ApiError && error.status === 501) {
        setUnavailable(error.message);
      } else {
        setCommandError(error instanceof Error ? error.message : "Could not update this Run.");
        if (error instanceof ApiError && error.status === 409) revalidator.revalidate();
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }

  return (
    <PageShell
      title="Run results"
      crumbs={[{ label: "Runs", to: "/runs" }, { label: "Run results" }]}
    >
      {connection === "reconnecting" ? <ConnectionStatus state="reconnecting" /> : null}
      {commandError ? (
        <p role="alert" className="text-sm text-status-danger [overflow-wrap:anywhere]">
          {commandError}
        </p>
      ) : null}
      <RunInspector run={run} busy={busy} unavailable={unavailable} onCommand={submit} />
      <RunBudgets state={budgets} />
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <ErrorState
      section="runs"
      status={error instanceof ApiError ? error.status : undefined}
      message={error instanceof Error ? error.message : undefined}
    />
  );
}
