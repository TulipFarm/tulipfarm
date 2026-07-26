import { useLoaderData, useRevalidator } from "@remix-run/react";
import { useState } from "react";
import { getGuardrails, proposeGuardrailToggle } from "~/lib/admin";

export async function clientLoader() {
  return { model: await getGuardrails() };
}

export default function GuardrailAdminRoute() {
  const { model } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState<string>();
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-lg font-semibold">Guardrails</h1>
        <p className="text-xs text-muted-foreground">
          Revision {model.revision}. Changes are Soul changesets and may require Approval.
        </p>
      </header>
      <ul className="divide-y divide-border border border-border bg-card">
        {model.items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-3 px-3 py-3 text-xs">
            <span className="font-medium">{item.name ?? item.id}</span>
            <span className="text-muted-foreground">
              {item.effect ?? "configured"} · {item.scope ?? "all"}
            </span>
            <button
              type="button"
              disabled={busy === item.id}
              onClick={async () => {
                setBusy(item.id);
                try {
                  await proposeGuardrailToggle(model, item, item.enabled === false);
                  revalidator.revalidate();
                } finally {
                  setBusy(undefined);
                }
              }}
              className="ml-auto rounded-sm border border-border px-2 py-1"
            >
              {item.enabled === false ? "Enable" : "Disable"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
