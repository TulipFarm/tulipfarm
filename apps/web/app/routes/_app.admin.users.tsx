import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { type FormEvent, useState } from "react";
import { Button } from "~/components/ui/button";
import { CopyField } from "~/components/ui/copy-field";
import { ApiError } from "~/lib/api";
import {
  createUser,
  type Invite,
  inviteUrl,
  listUsers,
  reissueInvite,
  type SettableUserStatus,
  setUserStatus,
  type UserStatus,
  type UserSummary,
} from "~/lib/users";

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

/**
 * Everything a row's status decides, in one table: what it is called, what re-issuing a link means
 * for it, and what the enable/disable toggle does next. A disabled account offers no link at all —
 * redeeming one would hand back an identity an admin deliberately switched off.
 */
const STATUS_ACTIONS: Record<
  UserStatus,
  {
    label: string;
    inviteLabel: string | null;
    toggleLabel: string;
    nextStatus: SettableUserStatus;
  }
> = {
  active: {
    label: "active",
    inviteLabel: "Reset password link",
    toggleLabel: "Disable",
    nextStatus: "disabled",
  },
  invited: {
    label: "invite pending",
    inviteLabel: "New invite link",
    toggleLabel: "Disable",
    nextStatus: "disabled",
  },
  disabled: {
    label: "disabled",
    inviteLabel: null,
    toggleLabel: "Enable",
    nextStatus: "active",
  },
};

// The one live link for a user, shown once. Re-issuing revokes whatever was outstanding, so the
// copy an admin shared a moment ago stops working the instant they generate a replacement.
function InvitePanel({
  email,
  invite,
  onDismiss,
}: {
  email: string;
  invite: Invite;
  onDismiss: () => void;
}) {
  const url = inviteUrl(invite);

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-primary/50 bg-primary/5 px-3 py-3 text-sm">
      <p>
        Invite link for <strong>{email}</strong>. Share it manually — it won't be shown again, and
        it expires {new Date(invite.expiresAt).toLocaleDateString()}.
      </p>
      <div className="flex items-center gap-2">
        <CopyField value={url} label="invite link" className="min-w-0 flex-1" />
        <button
          type="button"
          className="shrink-0 text-xs text-muted-foreground"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export default function UsersAdminRoute() {
  const { users } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ email: string; invite: Invite } | null>(null);
  const [rowBusy, setRowBusy] = useState<string>();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await createUser(email.trim());
      setIssued({ email: result.user.email, invite: result.invite });
      setEmail("");
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not reach the API");
    } finally {
      setBusy(false);
    }
  }

  async function onReissue(user: UserSummary) {
    setError(null);
    setRowBusy(user.id);
    try {
      setIssued({ email: user.email, invite: await reissueInvite(user.id) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not reach the API");
    } finally {
      setRowBusy(undefined);
    }
  }

  async function toggleStatus(user: UserSummary) {
    setRowBusy(user.id);
    try {
      await setUserStatus(user.id, STATUS_ACTIONS[user.status].nextStatus);
      revalidator.revalidate();
    } finally {
      setRowBusy(undefined);
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-lg font-semibold">Users</h1>
        <p className="text-xs text-muted-foreground">
          New users get an invite link to share manually; they choose their own password when they
          open it. A new link is also how someone who forgot their password gets back in.
        </p>
      </header>

      {issued ? (
        <InvitePanel
          email={issued.email}
          invite={issued.invite}
          onDismiss={() => setIssued(null)}
        />
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
          {busy ? "Inviting…" : "Invite user"}
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
            <span className="text-muted-foreground">{STATUS_ACTIONS[user.status].label}</span>
            {user.role !== "admin" ? (
              <span className="ml-auto flex items-center gap-2">
                {STATUS_ACTIONS[user.status].inviteLabel ? (
                  <button
                    type="button"
                    disabled={rowBusy === user.id}
                    onClick={() => onReissue(user)}
                    className="rounded-sm border border-border px-2 py-1"
                  >
                    {STATUS_ACTIONS[user.status].inviteLabel}
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={rowBusy === user.id}
                  onClick={() => toggleStatus(user)}
                  className="rounded-sm border border-border px-2 py-1"
                >
                  {STATUS_ACTIONS[user.status].toggleLabel}
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
