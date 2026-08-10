import { useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import { type FormEvent, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { CopyField } from "~/components/ui/copy-field";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { getRoles, type RolesModel } from "~/lib/admin";
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
import { shortRevision } from "~/lib/utils";

export async function clientLoader() {
  // Roles are informational here; a deployment that cannot serve them should still list people.
  const [users, roles] = await Promise.all([listUsers(), getRoles().catch(() => null)]);
  return { users, roles };
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
    tone: "success" | "warning" | "neutral";
    inviteLabel: string | null;
    toggleLabel: string;
    nextStatus: SettableUserStatus;
  }
> = {
  active: {
    label: "Active",
    tone: "success",
    inviteLabel: "Reset password link",
    toggleLabel: "Disable",
    nextStatus: "disabled",
  },
  invited: {
    label: "Invite pending",
    tone: "warning",
    inviteLabel: "New invite link",
    toggleLabel: "Disable",
    nextStatus: "disabled",
  },
  disabled: {
    label: "Disabled",
    tone: "neutral",
    inviteLabel: null,
    toggleLabel: "Enable",
    nextStatus: "active",
  },
};

export default function BusinessPeople() {
  const { users, roles } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ email: string; invite: Invite } | null>(null);
  const [rowBusy, setRowBusy] = useState<string>();

  function fail(err: unknown) {
    setError(err instanceof ApiError ? err.message : "Could not reach the API.");
  }

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await createUser(email.trim());
      setIssued({ email: result.user.email, invite: result.invite });
      setEmail("");
      revalidator.revalidate();
    } catch (err) {
      fail(err);
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
      fail(err);
    } finally {
      setRowBusy(undefined);
    }
  }

  async function toggleStatus(user: UserSummary) {
    setError(null);
    setRowBusy(user.id);
    try {
      await setUserStatus(user.id, STATUS_ACTIONS[user.status].nextStatus);
      revalidator.revalidate();
    } catch (err) {
      fail(err);
    } finally {
      setRowBusy(undefined);
    }
  }

  return (
    <div className="space-y-6">
      {error ? <FormStatus tone="error">{error}</FormStatus> : null}

      {issued ? (
        <Panel className="border-primary/40">
          <div className="space-y-2">
            <p className="text-sm text-foreground">
              Invite link for <strong>{issued.email}</strong>. Share it yourself — it is not shown
              again and it expires {new Date(issued.invite.expiresAt).toLocaleDateString()}.
            </p>
            <div className="flex items-center gap-2">
              <CopyField
                value={inviteUrl(issued.invite)}
                label="invite link"
                className="min-w-0 flex-1"
              />
              <Button variant="ghost" size="sm" onClick={() => setIssued(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Invite someone"
        description="They choose their own password when they open the link, so no credential is ever relayed on their behalf."
      >
        <form onSubmit={onInvite} className="flex items-end gap-2">
          <Field label="Email" className="flex-1">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </Field>
          <Button type="submit" size="sm" disabled={busy || email.trim().length === 0}>
            {busy ? "Inviting…" : "Send invite"}
          </Button>
        </form>
      </Panel>

      <Panel title="People" description="Everyone who can sign in to this workspace." flush>
        {users.length === 0 ? (
          <PanelEmpty>Nobody yet.</PanelEmpty>
        ) : (
          <ul>
            {users.map((user) => {
              const action = STATUS_ACTIONS[user.status];
              return (
                <li
                  key={user.id}
                  className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {user.name ?? user.email}
                    </p>
                    {user.name ? (
                      <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                    ) : null}
                  </div>
                  <Badge variant={user.role === "admin" ? "primary" : "neutral"}>{user.role}</Badge>
                  <Badge variant={action.tone}>{action.label}</Badge>
                  {/* An admin cannot be locked out or reset from here — that would let one admin
                      take the workspace from another. */}
                  {user.role !== "admin" ? (
                    <div className="flex shrink-0 items-center gap-2">
                      {action.inviteLabel ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={rowBusy === user.id}
                          onClick={() => onReissue(user)}
                        >
                          {action.inviteLabel}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={rowBusy === user.id}
                        onClick={() => toggleStatus(user)}
                      >
                        {action.toggleLabel}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <RolesPanel roles={roles} />
    </div>
  );
}

/**
 * Roles are defined in the soul repository, not here — this is the read-only view of what each one
 * actually grants, so an admin can answer "what does member mean" without reading YAML.
 */
function RolesPanel({ roles }: { roles: RolesModel | null }) {
  return (
    <Panel
      title="Roles"
      description={
        roles
          ? `What each role grants. Defined in the soul repository — revision ${shortRevision(roles.revision)}.`
          : "What each role grants."
      }
      flush
    >
      {!roles || roles.items.length === 0 ? (
        <PanelEmpty>No roles defined.</PanelEmpty>
      ) : (
        <ul>
          {roles.items.map((role) => (
            <li key={role.id} className="border-b border-border px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium text-foreground">{role.name}</span>
                <span className="text-xs text-muted-foreground">
                  Applies to {role.principalKinds.join(", ") || "nothing"}
                </span>
              </div>
              {role.grants.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">No grants.</p>
              ) : (
                <ul className="mt-1.5 space-y-0.5">
                  {role.grants.map((grant) => (
                    <li key={grant} className="text-xs text-muted-foreground">
                      {grant}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// listUsers 403s for non-admins (server-enforced — the sidebar link is hidden for them too, but the
// route stays directly reachable by URL). Show an in-page message instead of crashing the app.
export function ErrorBoundary() {
  const error = useRouteError();
  const message =
    error instanceof ApiError
      ? error.status === 403
        ? "Only an admin can manage people."
        : error.message
      : "Could not load people.";
  return <FormStatus tone="error">{message}</FormStatus>;
}
