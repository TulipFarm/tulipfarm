import { useLoaderData, useRevalidator } from "@remix-run/react";
import { useState } from "react";
import {
  type OperationAction,
  OperationsConsole,
} from "~/components/operations/operations-console";
import { commandOperation, getOperations } from "~/lib/operations";

export async function clientLoader() {
  return { model: await getOperations() };
}

export default function OperationsRoute() {
  const { model } = useLoaderData<typeof clientLoader>();
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
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <OperationsConsole model={model} busy={busy} onCommand={command} />
    </div>
  );
}
