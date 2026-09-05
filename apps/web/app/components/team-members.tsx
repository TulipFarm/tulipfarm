import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { ConfirmModal, Modal } from "~/components/ui/modal";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import type { AgentSummary } from "~/lib/agents";
import { ApiError } from "~/lib/api";
import {
  addTeamMembers,
  decideTeamLeave,
  removeTeamMember,
  removeTeamMembers,
  requestTeamLeave,
  type ServiceAccountSummary,
  type TeamBulkResult,
  type TeamDirectoryEntry,
  type TeamLeaveRequest,
  type TeamMember,
  updateTeamMember,
} from "~/lib/teams";
import type { UserSummary } from "~/lib/users";

type MemberFilter = "all" | TeamMember["principalKind"];

export function TeamMembers({
  team,
  teams,
  members,
  users,
  agents,
  serviceAccounts,
  leaveRequests,
  currentUserId,
  canManage,
  onChanged,
}: {
  team: TeamDirectoryEntry;
  teams: TeamDirectoryEntry[];
  members: { direct: TeamMember[]; inherited: TeamMember[] };
  users: UserSummary[];
  agents: AgentSummary[];
  serviceAccounts: ServiceAccountSummary[];
  leaveRequests: TeamLeaveRequest[];
  currentUserId?: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<MemberFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [bulkRemoveOpen, setBulkRemoveOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "error" | "success"; message: string } | null>(null);
  const [partialFailures, setPartialFailures] = useState<TeamBulkResult[]>([]);

  const allMembers = useMemo(() => [...members.direct, ...members.inherited], [members]);
  const visible = allMembers.filter(
    (member) => filter === "all" || member.principalKind === filter
  );
  const directHumanAdmins = members.direct.filter(
    (member) => member.principalKind === "user" && member.level === "admin"
  );
  const finalAdminId = directHumanAdmins.length === 1 ? directHumanAdmins[0]?.principalId : null;
  const names = memberNames(teams, users, agents, serviceAccounts);
  const selectedMembers = members.direct.filter((member) => selected.has(member.principalId));
  const selectable = visible.filter(
    (member) =>
      member.membership === "direct" && member.removable && member.principalId !== finalAdminId
  );
  const currentMembership = members.direct.find(
    (member) => member.principalId === currentUserId && member.principalKind === "user"
  );
  const pendingLeave = leaveRequests.filter((request) => request.status === "pending");

  async function mutate(key: string, operation: () => Promise<unknown>, success: string) {
    setBusy(key);
    setStatus(null);
    setPartialFailures([]);
    try {
      await operation();
      setStatus({ tone: "success", message: success });
      onChanged();
    } catch (error) {
      setStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function changeLevel(member: TeamMember) {
    const level = member.level === "admin" ? "member" : "admin";
    await mutate(
      `level:${member.principalId}`,
      () =>
        updateTeamMember(team.id, member.principalId, {
          level,
          expiresAt: member.expiresAt,
          revision: member.revision,
        }),
      level === "admin" ? "Member promoted to Team admin." : "Team admin demoted to member."
    );
  }

  async function confirmRemove() {
    if (!removing) return;
    const member = removing;
    await mutate(
      `remove:${member.principalId}`,
      () => removeTeamMember(team.id, member.principalId, member.revision),
      "Member removed."
    );
    setRemoving(null);
  }

  async function confirmBulkRemove() {
    setBusy("bulk-remove");
    setStatus(null);
    setPartialFailures([]);
    try {
      const result = await removeTeamMembers(
        team.id,
        selectedMembers.map((member) => ({
          principalId: member.principalId,
          revision: member.revision,
        }))
      );
      const failures = result.results.filter((item) => !item.ok);
      const removed = result.results.length - failures.length;
      setPartialFailures(failures);
      setStatus({
        tone: failures.length ? "error" : "success",
        message: failures.length
          ? `${removed} removed. ${failures.length} could not be removed.`
          : `${removed} ${removed === 1 ? "member" : "members"} removed.`,
      });
      setSelected(new Set(failures.map((failure) => failure.principalId)));
      if (removed > 0) onChanged();
    } catch (error) {
      setStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(null);
      setBulkRemoveOpen(false);
    }
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(selectable.map((member) => member.principalId)) : new Set());
  }

  return (
    <div className="space-y-4">
      {status && partialFailures.length === 0 ? (
        <FormStatus tone={status.tone}>{status.message}</FormStatus>
      ) : null}
      {partialFailures.length ? (
        <PartialErrors failures={partialFailures} names={names} summary={status?.message} />
      ) : null}

      <Panel
        title="Members"
        description="Direct membership is managed here. Inherited membership comes from a child Team."
        actions={
          canManage ? (
            <>
              {selectedMembers.length ? (
                <Button type="button" variant="destructive" onClick={() => setBulkRemoveOpen(true)}>
                  Remove selected ({selectedMembers.length})
                </Button>
              ) : null}
              <Button type="button" onClick={() => setAddOpen(true)}>
                Add members
              </Button>
            </>
          ) : undefined
        }
        flush
      >
        <fieldset className="flex flex-wrap gap-2 border-border border-b px-4 py-3">
          <legend className="sr-only">Filter members by identity type</legend>
          {(
            [
              ["all", "All"],
              ["user", "People"],
              ["agent", "Agents"],
              ["service", "Service accounts"],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm has-[:checked]:border-foreground has-[:checked]:bg-accent"
            >
              <input
                type="radio"
                name="member-filter"
                checked={filter === value}
                onChange={() => setFilter(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>

        {visible.length === 0 ? (
          <PanelEmpty>No members match this filter.</PanelEmpty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-border border-b text-xs text-muted-foreground">
                  {canManage ? (
                    <th className="w-12 px-4 py-3 font-medium">
                      <Checkbox
                        aria-label="Select all removable members"
                        checked={
                          selectable.length > 0 &&
                          selectable.every((member) => selected.has(member.principalId))
                        }
                        onChange={(event) => toggleAll(event.target.checked)}
                        disabled={selectable.length === 0}
                      />
                    </th>
                  ) : null}
                  <th className="px-4 py-3 font-medium">Member</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Membership</th>
                  <th className="px-4 py-3 font-medium">Level</th>
                  <th className="px-4 py-3 font-medium">Expiry</th>
                  {canManage ? <th className="px-4 py-3 text-right font-medium">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {visible.map((member) => {
                  const isFinalAdmin = member.principalId === finalAdminId;
                  const canSelect =
                    member.membership === "direct" && member.removable && !isFinalAdmin;
                  const sourceTeam = teams.find(
                    (candidate) => candidate.id === member.sourceTeamId
                  );
                  return (
                    <tr
                      key={`${member.membership}:${member.sourceTeamId}:${member.principalId}`}
                      className="border-border border-b last:border-b-0"
                    >
                      {canManage ? (
                        <td className="px-4 py-3">
                          <Checkbox
                            aria-label={`Select ${names.get(member.principalId) ?? member.principalId}`}
                            checked={selected.has(member.principalId)}
                            onChange={(event) => {
                              const next = new Set(selected);
                              if (event.target.checked) next.add(member.principalId);
                              else next.delete(member.principalId);
                              setSelected(next);
                            }}
                            disabled={!canSelect}
                          />
                        </td>
                      ) : null}
                      <td className="px-4 py-3">
                        <span className="font-medium text-foreground">
                          {names.get(member.principalId) ?? member.principalId}
                        </span>
                        <span className="block font-mono text-xs text-muted-foreground">
                          {member.principalId}
                        </span>
                      </td>
                      <td className="px-4 py-3">{kindLabel(member.principalKind)}</td>
                      <td className="px-4 py-3">
                        <Badge variant={member.membership === "direct" ? "primary" : "neutral"}>
                          {member.membership === "direct" ? "Direct" : "Inherited"}
                        </Badge>
                        {member.membership === "inherited" && sourceTeam ? (
                          <Link
                            className="ml-2 text-xs"
                            to={`/teams/${encodeURIComponent(sourceTeam.slug)}?section=members`}
                          >
                            from {sourceTeam.displayName}
                          </Link>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        {member.level === "admin" ? "Team admin" : "Member"}
                        {isFinalAdmin ? (
                          <span className="block text-xs text-muted-foreground">
                            Final Team admin
                          </span>
                        ) : null}
                        {member.principalKind !== "user" ? (
                          <span className="block text-xs text-muted-foreground">
                            People only can be Team admins
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <time dateTime={member.expiresAt ?? undefined}>
                          {formatDate(member.expiresAt)}
                        </time>
                      </td>
                      {canManage ? (
                        <td className="px-4 py-3">
                          {member.membership === "direct" ? (
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => changeLevel(member)}
                                disabled={
                                  busy !== null || member.principalKind !== "user" || isFinalAdmin
                                }
                              >
                                {member.level === "admin" ? "Demote" : "Promote"}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setEditing(member)}
                                disabled={busy !== null}
                              >
                                Extend expiry
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                onClick={() => setRemoving(member)}
                                disabled={busy !== null || !member.removable || isFinalAdmin}
                              >
                                Remove
                              </Button>
                            </div>
                          ) : (
                            <span className="block text-right text-xs text-muted-foreground">
                              Manage in source Team
                            </span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {currentMembership ? (
        <Panel title="Leave this Team">
          <p className="text-sm text-muted-foreground">
            A Team admin must approve your request before your direct membership is removed.
          </p>
          {currentMembership.principalId === finalAdminId ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Add another human Team admin before you can request to leave.
            </p>
          ) : (
            <Button
              type="button"
              className="mt-3"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                mutate(
                  "leave",
                  () => requestTeamLeave(team.id),
                  "Leave request sent to the Team admins."
                )
              }
            >
              Request to leave
            </Button>
          )}
        </Panel>
      ) : null}

      {canManage ? (
        <LeaveRequests
          requests={pendingLeave}
          names={names}
          busy={busy}
          onDecision={(request, decision) =>
            mutate(
              `leave:${request.id}`,
              () => decideTeamLeave(team.id, request.id, decision, request.revision),
              decision === "approved" ? "Leave request approved." : "Leave request rejected."
            )
          }
        />
      ) : null}

      <AddMembersModal
        open={addOpen}
        teamId={team.id}
        onClose={() => setAddOpen(false)}
        onComplete={(results) => {
          const failures = results.filter((item) => !item.ok);
          const added = results.length - failures.length;
          setPartialFailures(failures);
          setStatus({
            tone: failures.length ? "error" : "success",
            message: failures.length
              ? `${added} added. ${failures.length} could not be added.`
              : `${added} ${added === 1 ? "member" : "members"} added.`,
          });
          if (added > 0) onChanged();
        }}
      />
      <ExpiryModal
        member={editing}
        name={editing ? (names.get(editing.principalId) ?? editing.principalId) : ""}
        teamId={team.id}
        onClose={() => setEditing(null)}
        onChanged={() => {
          setEditing(null);
          setStatus({ tone: "success", message: "Membership expiry updated." });
          onChanged();
        }}
      />
      <ConfirmModal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={confirmRemove}
        title="Remove member?"
        description={
          removing
            ? `Remove ${names.get(removing.principalId) ?? removing.principalId} from ${team.displayName}?`
            : ""
        }
        confirmLabel="Remove member"
        busy={busy?.startsWith("remove:") ?? false}
      />
      <ConfirmModal
        open={bulkRemoveOpen}
        onClose={() => setBulkRemoveOpen(false)}
        onConfirm={confirmBulkRemove}
        title="Remove selected members?"
        description={`Remove ${selectedMembers.length} selected direct ${selectedMembers.length === 1 ? "member" : "members"}? Each removal is validated by the server.`}
        confirmLabel="Remove selected"
        busy={busy === "bulk-remove"}
      />
    </div>
  );
}

export function TeamLeaveAction({
  teamId,
  isFinalAdmin,
  onChanged,
}: {
  teamId: string;
  isFinalAdmin: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "error" | "success"; message: string } | null>(null);

  async function request() {
    setBusy(true);
    setStatus(null);
    try {
      await requestTeamLeave(teamId);
      setStatus({ tone: "success", message: "Leave request sent to the Team admins." });
      onChanged();
    } catch (error) {
      setStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Leave this Team">
      <p className="text-sm text-muted-foreground">
        A Team admin must approve your request before your direct membership is removed.
      </p>
      {isFinalAdmin ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Add another human Team admin before you can request to leave.
        </p>
      ) : (
        <Button type="button" className="mt-3" variant="outline" disabled={busy} onClick={request}>
          {busy ? "Sending…" : "Request to leave"}
        </Button>
      )}
      {status ? (
        <div className="mt-3">
          <FormStatus tone={status.tone}>{status.message}</FormStatus>
        </div>
      ) : null}
    </Panel>
  );
}

function AddMembersModal({
  open,
  teamId,
  onClose,
  onComplete,
}: {
  open: boolean;
  teamId: string;
  onClose: () => void;
  onComplete: (results: TeamBulkResult[]) => void;
}) {
  const [principalIds, setPrincipalIds] = useState("");
  const [level, setLevel] = useState<"member" | "admin">("member");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idsRef = useRef<HTMLTextAreaElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const ids = principalIds
      .split(/\s|,/)
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      setError("Enter at least one principal ID.");
      idsRef.current?.focus();
      return;
    }
    if (ids.length > 100) {
      setError("Add no more than 100 members at a time.");
      idsRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const result = await addTeamMembers(
        teamId,
        ids.map((principalId) => ({
          principalId,
          level,
          ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        }))
      );
      onComplete(result.results);
      setPrincipalIds("");
      setLevel("member");
      setExpiresAt("");
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Team members">
      <form className="space-y-4" onSubmit={submit}>
        {error ? (
          <p role="alert" className="rounded-md border border-destructive/30 p-3 text-destructive">
            {error}
          </p>
        ) : null}
        <Field
          label="Principal IDs"
          required
          help="Enter one person, Agent, or service account ID per line. Up to 100."
          error={error?.startsWith("Enter") || error?.startsWith("Add no") ? error : undefined}
        >
          <Textarea
            ref={idsRef}
            value={principalIds}
            onChange={(event) => setPrincipalIds(event.target.value)}
            rows={5}
          />
        </Field>
        <Field
          label="Membership level"
          help="Only people can be Team admins. Invalid rows are returned as explicit errors."
        >
          <Select value={level} onChange={(event) => setLevel(event.target.value as typeof level)}>
            <option value="member">Member</option>
            <option value="admin">Team admin</option>
          </Select>
        </Field>
        <Field label="Optional expiry">
          <Input
            type="datetime-local"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add members"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ExpiryModal({
  member,
  name,
  teamId,
  onClose,
  onChanged,
}: {
  member: TeamMember | null;
  name: string;
  teamId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setExpiresAt(member?.expiresAt ? member.expiresAt.slice(0, 16) : "");
    setError(null);
  }, [member]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!member) return;
    setBusy(true);
    setError(null);
    try {
      await updateTeamMember(teamId, member.principalId, {
        level: member.level,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        revision: member.revision,
      });
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={member !== null} onClose={onClose} title={`Extend expiry for ${name}`}>
      <form className="space-y-4" onSubmit={submit}>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <Field
          label="New expiry"
          help="Leave blank to remove the expiry. The server rejects an expiry in the past."
        >
          <Input
            type="datetime-local"
            value={expiresAt}
            min={new Date().toISOString().slice(0, 16)}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save expiry"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function LeaveRequests({
  requests,
  names,
  busy,
  onDecision,
}: {
  requests: TeamLeaveRequest[];
  names: Map<string, string>;
  busy: string | null;
  onDecision: (request: TeamLeaveRequest, decision: "approved" | "rejected") => void;
}) {
  return (
    <Panel
      title="Leave requests"
      description="Approve or reject pending requests from direct members."
    >
      {requests.length === 0 ? (
        <PanelEmpty>No pending leave requests.</PanelEmpty>
      ) : (
        <ul className="divide-y divide-border">
          {requests.map((request) => (
            <li
              key={request.id}
              className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm font-medium">
                  {names.get(request.principalId) ?? request.principalId}
                </p>
                <p className="text-xs text-muted-foreground">
                  Requested {formatDate(request.requestedAt)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => onDecision(request, "rejected")}
                >
                  Reject
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => onDecision(request, "approved")}
                >
                  Approve
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function PartialErrors({
  failures,
  names,
  summary,
}: {
  failures: TeamBulkResult[];
  names: Map<string, string>;
  summary?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="rounded-md border border-destructive/30 p-4"
    >
      <p className="text-sm font-semibold text-destructive">Some members were not changed.</p>
      {summary ? <p className="mt-1 text-sm">{summary}</p> : null}
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
        {failures.map((failure) => (
          <li key={failure.principalId}>
            {names.get(failure.principalId) ?? failure.principalId}:{" "}
            {failure.error ?? "The server rejected this change."}
          </li>
        ))}
      </ul>
    </div>
  );
}

function memberNames(
  teams: TeamDirectoryEntry[],
  users: UserSummary[],
  agents: AgentSummary[],
  serviceAccounts: ServiceAccountSummary[]
): Map<string, string> {
  const names = new Map<string, string>();
  for (const candidate of teams) {
    for (const member of candidate.members) names.set(member.principalId, member.name);
  }
  for (const user of users) names.set(user.id, user.name?.trim() || user.email);
  for (const agent of agents) names.set(agent.name, agent.label?.trim() || agent.name);
  for (const account of serviceAccounts) names.set(account.id, account.name);
  return names;
}

function kindLabel(kind: TeamMember["principalKind"]): string {
  if (kind === "user") return "Person";
  if (kind === "agent") return "Agent";
  return "Service account";
}

function formatDate(value: string | null): string {
  if (!value) return "No expiry";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "The member change could not be completed.";
}
