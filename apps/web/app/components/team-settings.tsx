import { useNavigate } from "@remix-run/react";
import type { Team, TeamHierarchy } from "@tulipfarm/schema";
import { type FormEvent, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Button } from "~/components/ui/button";
import { Field, ReadonlyField } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { ConfirmModal, Modal } from "~/components/ui/modal";
import { Panel } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { ApiError } from "~/lib/api";
import {
  archiveTeam,
  confirmTeamMove,
  deleteTeam,
  formatTeamLabels,
  parseTeamLabels,
  previewTeamMove,
  recoverTeamAdmin,
  type TeamDirectoryEntry,
  type TeamMember,
  type TeamMovePreview,
  updateTeam,
} from "~/lib/teams";
import type { UserSummary } from "~/lib/users";

type Loadable<T> = { ok: true; value: T } | { ok: false; message: string };

export function TeamSettings({
  team,
  teams,
  hierarchy,
  members,
  users,
  canEdit,
  isBusinessAdmin,
  onChanged,
}: {
  team: Team;
  teams: TeamDirectoryEntry[];
  hierarchy: TeamHierarchy[];
  members: Loadable<{ direct: TeamMember[]; inherited: TeamMember[] }>;
  users: Loadable<UserSummary[]>;
  canEdit: boolean;
  isBusinessAdmin: boolean;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(team.displayName);
  const [description, setDescription] = useState(team.description ?? "");
  const [labels, setLabels] = useState(formatTeamLabels(team.labels));
  const [busyAction, setBusyAction] = useState<string>();
  const [status, setStatus] = useState<{ tone: "error" | "success"; message: string } | null>(null);
  const [moveParentId, setMoveParentId] = useState(team.parentTeamId ?? "");
  const [movePreview, setMovePreview] = useState<TeamMovePreview | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryPrincipalId, setRecoveryPrincipalId] = useState("");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const displayNameConflict = teams.some(
    (candidate) =>
      candidate.id !== team.id &&
      candidate.parentTeamId === team.parentTeamId &&
      candidate.displayName.trim().toLocaleLowerCase() === displayName.trim().toLocaleLowerCase()
  );
  const descendants = new Set(
    hierarchy
      .filter((entry) => entry.ancestorTeamIds.includes(team.id))
      .map((entry) => entry.teamId)
  );
  const parentOptions = teams.filter(
    (candidate) =>
      candidate.status === "active" && candidate.id !== team.id && !descendants.has(candidate.id)
  );
  const activeUsers = users.ok ? users.value.filter((user) => user.status === "active") : [];
  const activeUserIds = new Set(activeUsers.map((user) => user.id));
  const eligibleRecoveryUserIds = new Set(
    members.ok
      ? members.value.direct
          .filter(
            (member) =>
              member.principalKind === "user" &&
              activeUserIds.has(member.principalId) &&
              (!member.expiresAt || Date.parse(member.expiresAt) > Date.now())
          )
          .map((member) => member.principalId)
      : []
  );
  const eligibleRecoveryUsers = activeUsers.filter((user) => eligibleRecoveryUserIds.has(user.id));
  const hasActiveHumanAdmin =
    members.ok &&
    members.value.direct.some(
      (member) =>
        member.principalKind === "user" &&
        member.level === "admin" &&
        activeUserIds.has(member.principalId) &&
        (!member.expiresAt || Date.parse(member.expiresAt) > Date.now())
    );
  const canRecover =
    isBusinessAdmin &&
    team.status === "active" &&
    members.ok &&
    users.ok &&
    !hasActiveHumanAdmin &&
    eligibleRecoveryUsers.length > 0;

  async function save(event: FormEvent) {
    event.preventDefault();
    setStatus(null);
    if (!displayName.trim() || displayNameConflict) return;
    setBusyAction("save");
    try {
      await updateTeam(team.id, {
        displayName: displayName.trim(),
        description: description.trim() || null,
        labels: parseTeamLabels(labels),
        revision: team.revision,
      });
      setStatus({ tone: "success", message: "Team details saved." });
      onChanged();
    } catch (error) {
      setStatus({ tone: "error", message: message(error, "Could not save Team details.") });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function previewMove(event: FormEvent) {
    event.preventDefault();
    setStatus(null);
    setMovePreview(null);
    setBusyAction("preview");
    try {
      setMovePreview(await previewTeamMove(team.id, moveParentId, team.revision));
    } catch (error) {
      setStatus({ tone: "error", message: message(error, "Could not preview this move.") });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function confirmMove() {
    if (!movePreview) return;
    setBusyAction("move");
    setStatus(null);
    try {
      await confirmTeamMove(team.id, movePreview.proposedParentTeamId, movePreview.previewToken);
      setMovePreview(null);
      setStatus({ tone: "success", message: "Team moved." });
      onChanged();
    } catch (error) {
      setStatus({ tone: "error", message: message(error, "Could not move this Team.") });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function archive() {
    setBusyAction("archive");
    setArchiveError(null);
    try {
      await archiveTeam(team.id, team.revision);
      setArchiveOpen(false);
      setStatus({ tone: "success", message: "Team archived." });
      onChanged();
    } catch (error) {
      setArchiveError(message(error, "Could not archive this Team."));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function destroy() {
    setBusyAction("delete");
    setDeleteError(null);
    try {
      await deleteTeam(team.id, team.revision);
      navigate("/teams");
    } catch (error) {
      setDeleteError(message(error, "Could not delete this Team."));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function recoverAdmin(event: FormEvent) {
    event.preventDefault();
    if (!recoveryPrincipalId) {
      setRecoveryError("Choose an active person.");
      return;
    }
    setBusyAction("recover");
    setRecoveryError(null);
    try {
      await recoverTeamAdmin(team.id, recoveryPrincipalId, team.revision);
      setRecoveryOpen(false);
      setRecoveryPrincipalId("");
      setStatus({ tone: "success", message: "Team admin access recovered." });
      onChanged();
    } catch (error) {
      setRecoveryError(message(error, "Could not recover Team admin access."));
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <div className="space-y-4">
      {canEdit ? (
        <Panel
          title="Team details"
          description="Team admins can change the display name and description. The slug stays permanent."
        >
          <form className="space-y-4" onSubmit={save}>
            <Field
              label="Display name"
              required
              error={
                displayNameConflict ? "A sibling Team already uses this display name." : undefined
              }
            >
              <Input
                value={displayName}
                maxLength={256}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>
            <Field label="Description">
              <Textarea
                value={description}
                maxLength={2000}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field
              label="Labels"
              help="Separate labels with commas. Labels make Teams easier to search and filter."
            >
              <Input
                value={labels}
                maxLength={500}
                placeholder="engineering, infrastructure"
                onChange={(event) => setLabels(event.target.value)}
              />
            </Field>
            <dl>
              <ReadonlyField label="Immutable slug">
                <code>{team.slug}</code>
              </ReadonlyField>
            </dl>
            <Button
              type="submit"
              disabled={busyAction === "save" || !displayName.trim() || displayNameConflict}
            >
              {busyAction === "save" ? "Saving…" : "Save details"}
            </Button>
          </form>
        </Panel>
      ) : (
        <Panel title="Team details">
          <p className="text-sm text-muted-foreground">
            Only an exact Team admin can edit this Team's display name and description.
          </p>
        </Panel>
      )}

      {isBusinessAdmin ? (
        <Panel
          title="Company admin controls"
          description="Hierarchy, recovery, and lifecycle changes stay with company admins."
        >
          {team.status === "active" ? (
            <form className="mt-4 space-y-3" onSubmit={previewMove}>
              <Field label="Move under">
                <Select
                  value={moveParentId}
                  onChange={(event) => {
                    setMoveParentId(event.target.value);
                    setMovePreview(null);
                  }}
                >
                  {parentOptions.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.displayName}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                type="submit"
                variant="outline"
                disabled={
                  busyAction === "preview" || !moveParentId || moveParentId === team.parentTeamId
                }
              >
                {busyAction === "preview" ? "Previewing…" : "Preview move"}
              </Button>
            </form>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-2 border-border border-t pt-4">
            {team.status === "active" ? (
              <Button type="button" variant="outline" onClick={() => setArchiveOpen(true)}>
                Archive Team
              </Button>
            ) : (
              <Button type="button" variant="destructive" onClick={() => setDeleteOpen(true)}>
                Delete Team
              </Button>
            )}
            {canRecover ? (
              <Button type="button" variant="destructive" onClick={() => setRecoveryOpen(true)}>
                Recover Team admin
              </Button>
            ) : null}
          </div>
          {team.status === "active" ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Archive this Team before it can be permanently deleted.
            </p>
          ) : null}
          {status ? (
            <div className="mt-3" role={status.tone === "error" ? "alert" : "status"}>
              <FormStatus tone={status.tone}>{status.message}</FormStatus>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {movePreview ? (
        <MoveConfirmation
          preview={movePreview}
          teams={teams}
          users={users.ok ? users.value : []}
          busy={busyAction === "move"}
          error={status?.tone === "error" ? status.message : null}
          onClose={() => setMovePreview(null)}
          onConfirm={() => void confirmMove()}
        />
      ) : null}
      <ConfirmModal
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        onConfirm={() => void archive()}
        title={`Archive ${team.displayName}?`}
        description="Archiving immediately disables this Team's membership and authority. Child Teams and sole-owned assets must be moved first."
        confirmLabel="Archive Team"
        busyLabel="Archiving…"
        busy={busyAction === "archive"}
        error={archiveError}
      />
      <ConfirmModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void destroy()}
        title={`Delete ${team.displayName} permanently?`}
        description="Only an empty archived Team can be deleted. This cannot be undone."
        confirmLabel="Delete Team permanently"
        busyLabel="Deleting…"
        busy={busyAction === "delete"}
        error={deleteError}
      />
      <Modal
        open={recoveryOpen}
        onClose={() => setRecoveryOpen(false)}
        title="Recover Team admin access"
      >
        <form onSubmit={recoverAdmin}>
          <p className="text-sm text-muted-foreground">
            This Team has no active human Team admin. Choose an active direct member to become an
            exact Team admin.
          </p>
          <div className="mt-4">
            <Field label="New Team admin" required>
              <Select
                value={recoveryPrincipalId}
                onChange={(event) => setRecoveryPrincipalId(event.target.value)}
              >
                <option value="">Choose an active direct member…</option>
                {eligibleRecoveryUsers.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name ?? user.email}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {recoveryError ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {recoveryError}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRecoveryOpen(false)}
              disabled={busyAction === "recover"}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={busyAction === "recover"}>
              {busyAction === "recover" ? "Recovering…" : "Recover Team admin"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function MoveConfirmation({
  preview,
  teams,
  users,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  preview: TeamMovePreview;
  teams: TeamDirectoryEntry[];
  users: UserSummary[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const teamNames = new Map(teams.map((team) => [team.id, team.displayName]));
  const userNames = new Map(users.map((user) => [user.id, user.name ?? user.email]));
  const principalName = (id: string) => userNames.get(id) ?? id;
  return (
    <Modal open onClose={onClose} title="Confirm Team move" className="max-w-2xl">
      <p className="text-sm text-muted-foreground">
        Review every access change before moving this Team. This preview expires{" "}
        <time dateTime={preview.previewExpiresAt}>{formatDateTime(preview.previewExpiresAt)}</time>.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <ImpactList
          title="Hierarchy gained"
          empty="No ancestor Teams gained."
          items={preview.gainedAncestorTeamIds.map((id) => teamNames.get(id) ?? id)}
        />
        <ImpactList
          title="Hierarchy lost"
          empty="No ancestor Teams lost."
          items={preview.lostAncestorTeamIds.map((id) => teamNames.get(id) ?? id)}
        />
        <AuthorityImpact
          title="Roles"
          gained={preview.roles.gained.map(
            (item) => `${item.id} from ${teamNames.get(item.sourceTeamId) ?? item.sourceTeamId}`
          )}
          lost={preview.roles.lost.map(
            (item) => `${item.id} from ${teamNames.get(item.sourceTeamId) ?? item.sourceTeamId}`
          )}
        />
        <AuthorityImpact
          title="Grants"
          gained={preview.grants.gained.map(
            (item) => `${item.id} from ${teamNames.get(item.sourceTeamId) ?? item.sourceTeamId}`
          )}
          lost={preview.grants.lost.map(
            (item) => `${item.id} from ${teamNames.get(item.sourceTeamId) ?? item.sourceTeamId}`
          )}
        />
        <AuthorityImpact
          title="Assets"
          gained={preview.assets.gained.map(
            (item) =>
              `${item.assetType} ${item.assetId} from ${
                teamNames.get(item.sourceTeamId) ?? item.sourceTeamId
              }`
          )}
          lost={preview.assets.lost.map(
            (item) =>
              `${item.assetType} ${item.assetId} from ${
                teamNames.get(item.sourceTeamId) ?? item.sourceTeamId
              }`
          )}
        />
        <ImpactList
          title="Identities in the moved branch"
          empty="No identities are attached to the moved branch."
          items={preview.identities.map(
            (identity) =>
              `${principalName(identity.principalId)} (${identity.principalKind}) — direct Teams: ${
                identity.directTeamIds.map((id) => teamNames.get(id) ?? id).join(", ") || "none"
              }`
          )}
        />
        <ImpactList
          title="Affected identities"
          empty="No identity access changes."
          items={preview.accessChanges.map((change) => {
            const gained = [
              ...change.gainedRoleIds.map((id) => `Role ${id}`),
              ...change.gainedGrantIds.map((id) => `grant ${id}`),
              ...change.gainedAssetIds.map((id) => `asset ${id}`),
            ];
            const lost = [
              ...change.lostRoleIds.map((id) => `Role ${id}`),
              ...change.lostGrantIds.map((id) => `grant ${id}`),
              ...change.lostAssetIds.map((id) => `asset ${id}`),
            ];
            return `${principalName(change.principalId)} — gains ${
              gained.join(", ") || "nothing"
            }; loses ${lost.join(", ") || "nothing"}`;
          })}
        />
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={onConfirm} disabled={busy}>
          {busy ? "Moving…" : "Confirm move"}
        </Button>
      </div>
    </Modal>
  );
}

function AuthorityImpact({
  title,
  gained,
  lost,
}: {
  title: string;
  gained: string[];
  lost: string[];
}) {
  return (
    <section className="rounded-md border border-border p-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <ImpactList title="Gained" empty="None gained." items={gained} nested />
      <ImpactList title="Lost" empty="None lost." items={lost} nested />
    </section>
  );
}

function ImpactList({
  title,
  items,
  empty,
  nested = false,
}: {
  title: string;
  items: string[];
  empty: string;
  nested?: boolean;
}) {
  return (
    <section className={nested ? "mt-3" : "rounded-md border border-border p-3"}>
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
