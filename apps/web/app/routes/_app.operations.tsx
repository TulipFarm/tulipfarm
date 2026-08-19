import { useLoaderData, useRevalidator } from "@remix-run/react";
import { useState } from "react";
import { KillSwitchPanel } from "~/components/kill-switches/kill-switch-panel";
import {
  type OperationAction,
  OperationsConsole,
} from "~/components/operations/operations-console";
import { getKillSwitches, type KillSwitchModel } from "~/lib/kill-switches";
import { commandOperation, getOperations } from "~/lib/operations";

export async function clientLoader() {
  // Arming a stop is admin-only while the console itself is not, so a non-admin gets no panel
  // rather than a page that fails to load.
  const [model, killSwitches] = await Promise.all([
    getOperations(),
    getKillSwitches().catch((): KillSwitchModel | null => null),
  ]);
  return { model, killSwitches };
}

export default function OperationsRoute() {
  const { model, killSwitches } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
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
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      {killSwitches ? (
        <KillSwitchPanel model={killSwitches} onChanged={() => revalidator.revalidate()} />
      ) : null}
      <OperationsConsole
        model={model}
        busy={busy}
        onCommand={command}
        onRefresh={() => revalidator.revalidate()}
      />
    </div>
  );
}
