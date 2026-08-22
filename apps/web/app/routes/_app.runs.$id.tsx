import {
  type ClientLoaderFunctionArgs,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import { useEffect, useState } from "react";
import { RunBudgets, type RunBudgetsState } from "~/components/runs/run-budgets";
import { RunInspector } from "~/components/runs/run-inspector";
import { ConnectionStatus } from "~/components/shell/states";
import { ErrorState } from "~/components/states";
import { API_BASE, ApiError } from "~/lib/api";
import {
  commandRun,
  getOperationalRun,
  getRunBudgets,
  type RunCommandAction,
} from "~/lib/operations";

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  if (!params.id) throw new ApiError(404, "Run not found");
  return { run: await getOperationalRun(params.id) };
}

export default function OperationalRunRoute() {
  const { run } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState<string>();
  const [connection, setConnection] = useState<"online" | "reconnecting">("online");
  const [budgets, setBudgets] = useState<RunBudgetsState>({ status: "loading" });

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
    setBusy(true);
    try {
      await commandRun(run, action, `Operator requested ${action} from the Run inspector`);
      revalidator.revalidate();
    } catch (error) {
      // 501 means this deployment has no authority for the command at all, not that this attempt
      // failed. Lock the controls and repeat the server's reason instead of inviting a retry.
      if (!(error instanceof ApiError) || error.status !== 501) throw error;
      setUnavailable(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6">
        {connection === "reconnecting" ? <ConnectionStatus state="reconnecting" /> : null}
        <RunInspector run={run} busy={busy} unavailable={unavailable} onCommand={submit} />
        <RunBudgets state={budgets} />
      </div>
    </div>
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
