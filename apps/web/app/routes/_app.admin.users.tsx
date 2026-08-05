import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { type FormEvent, useState } from "react";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { copyText } from "~/lib/clipboard";
import { createUser, listUsers, setUserStatus, type UserSummary } from "~/lib/users";

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

export async function clientLoader() {
  return { users: await listUsers() };
}

// listUsers 403s for non-admins (server-enforced — the sidebar link is also hidden for them, but
// the route stays directly reachable by URL). Show an in-page message instead of crashing the app.
export function ErrorBoundary() {
  const error = useRouteError();
  const message = error instanceof ApiError ? error.message : "could not load users";
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-2 px-4 py-6 sm:px-6">
      <h1 className="text-lg font-semibold">Users</h1>
      <p role="alert" className="text-sm text-destructive">
        error: {message}
      </p>
    </div>
  );
}

export default function UsersAdminRoute() {
  const { users } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ user: UserSummary; temporaryPassword: string } | null>(
    null
  );
  const [copied, setCopied] = useState(false);
  const [statusBusy, setStatusBusy] = useState<string>();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await createUser(email.trim());
      setCreated(result);
      setCopied(false);
      setEmail("");
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not reach the API");
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(user: UserSummary) {
    setStatusBusy(user.id);
    try {
      await setUserStatus(user.id, user.status === "active" ? "disabled" : "active");
      revalidator.revalidate();
    } finally {
      setStatusBusy(undefined);
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-lg font-semibold">Users</h1>
        <p className="text-xs text-muted-foreground">
          New users get a temporary password to share manually; they reset it on first login.
        </p>
      </header>

      {created ? (
        <div className="flex flex-col gap-2 rounded-sm border border-primary/50 bg-primary/5 px-3 py-3 text-sm">
          <p>
            Created <strong>{created.user.email}</strong>. Share this temporary password — it won't
            be shown again:
          </p>
          <div className="flex items-center gap-2">
            <code className="rounded-sm border border-border bg-background px-2 py-1 text-xs">
              {created.temporaryPassword}
            </code>
            <button
              type="button"
              className="rounded-sm border border-border px-2 py-1 text-xs"
              onClick={async () => setCopied(await copyText(created.temporaryPassword))}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              className="ml-auto text-xs text-muted-foreground"
              onClick={() => setCreated(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
          email
          <input
            type="email"
            className={inputClass}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="email"
          />
        </label>
        <Button type="submit" className="rounded-sm" disabled={busy || email.trim().length === 0}>
          {busy ? "Adding…" : "Add user"}
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          error: {error}
        </p>
      ) : null}

      <ul className="divide-y divide-border border border-border bg-card">
        {users.map((user) => (
          <li key={user.id} className="flex flex-wrap items-center gap-3 px-3 py-3 text-xs">
            <span className="font-medium">{user.email}</span>
            <span className="text-muted-foreground">{user.role}</span>
            <span className="text-muted-foreground">{user.status}</span>
            {user.mustResetPassword ? (
              <span className="rounded-sm border border-border px-1.5 py-0.5 text-[0.625rem] uppercase text-muted-foreground">
                must reset password
              </span>
            ) : null}
            {user.role !== "admin" ? (
              <button
                type="button"
                disabled={statusBusy === user.id}
                onClick={() => toggleStatus(user)}
                className="ml-auto rounded-sm border border-border px-2 py-1"
              >
                {user.status === "active" ? "Disable" : "Enable"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
