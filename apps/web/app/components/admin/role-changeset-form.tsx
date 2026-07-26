import type { FormEvent } from "react";
import { useState } from "react";

type RoleCandidate = {
  id: string;
  name: string;
  principalKinds: string[];
  grants: string[];
  conditions: string[];
};

type RoleChangesetFormProps = {
  onPropose: (role: RoleCandidate) => Promise<void>;
};

function commaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function RoleChangesetForm({ onPropose }: RoleChangesetFormProps) {
  const [status, setStatus] = useState<"idle" | "submitting" | "proposed" | "failed">("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setStatus("submitting");
    const data = new FormData(form);

    try {
      await onPropose({
        id: String(data.get("id") ?? "").trim(),
        name: String(data.get("name") ?? "").trim(),
        principalKinds: commaSeparated(String(data.get("principalKinds") ?? "")),
        grants: commaSeparated(String(data.get("grants") ?? "")),
        conditions: [],
      });
      setStatus("proposed");
      form.reset();
    } catch {
      setStatus("failed");
    }
  }

  return (
    <form
      className="grid gap-3 border border-border bg-card p-3 sm:grid-cols-2"
      onSubmit={handleSubmit}
    >
      <h2 className="text-sm font-semibold sm:col-span-2">Propose a custom Role</h2>
      <label className="grid gap-1 text-xs">
        Role ID
        <input className="border border-border bg-background px-2 py-1.5" name="id" required />
      </label>
      <label className="grid gap-1 text-xs">
        Role name
        <input className="border border-border bg-background px-2 py-1.5" name="name" required />
      </label>
      <label className="grid gap-1 text-xs">
        Principal kinds
        <input
          className="border border-border bg-background px-2 py-1.5"
          name="principalKinds"
          placeholder="user, agent"
          required
        />
      </label>
      <label className="grid gap-1 text-xs">
        Grants
        <input
          className="border border-border bg-background px-2 py-1.5"
          name="grants"
          placeholder="runs:read, runs:reconcile"
          required
        />
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button
          className="border border-border px-3 py-1.5 text-xs font-medium"
          disabled={status === "submitting"}
          type="submit"
        >
          {status === "submitting" ? "Proposing…" : "Propose Role"}
        </button>
        {status === "proposed" ? (
          <p className="text-xs text-muted-foreground">Role changeset proposed.</p>
        ) : null}
        {status === "failed" ? (
          <p className="text-xs text-destructive" role="alert">
            Role proposal failed.
          </p>
        ) : null}
      </div>
    </form>
  );
}
