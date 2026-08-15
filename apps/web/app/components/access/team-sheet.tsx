import { Plus, UserPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LevelBuilder } from "~/components/access/level-builder";
import { Button } from "~/components/ui/button";
import { Field, FieldAction } from "~/components/ui/field";
import { Select } from "~/components/ui/select";
import { type Directory, lookupParty } from "~/lib/access-directory";
import { roleNamer, roleTitle, summarizeRole } from "~/lib/access-language";
import {
  type AuthzGrant,
  type AuthzGroupDetail,
  type AuthzRole,
  addGroupMember,
  type CapabilityCatalog,
  deleteGroup,
  grantRoleToGroup,
  removeGroupMember,
  revokeRoleFromGroup,
} from "~/lib/authz";
import type { UserSummary } from "~/lib/users";
import {
  CapabilityList,
  ExpiryNote,
  PartyLine,
  RawGrantList,
  RoleCard,
  TechnicalDetails,
} from "./access-bits";

export type Mutate = (key: string, operation: () => Promise<unknown>) => Promise<boolean>;

/** Written by the account trigger, not by this page. Offering them would desync `users.role`. */
const ACCOUNT_ROLE_IDS: ReadonlySet<string> = new Set(["admin", "member"]);

export function teamCapabilities(
  team: AuthzGroupDetail,
  roleById: Map<string, AuthzRole>
): AuthzGrant[] {
  return team.roles.flatMap((held) => roleById.get(held.roleId)?.grants ?? []);
}

export function TeamSheet({
  team,
  roles,
  roleById,
  catalog,
  onLevelCreated,
  users,
  directory,
  busy,
  mutate,
  onDeleted,
}: {
  team: AuthzGroupDetail;
  roles: AuthzRole[];
  roleById: Map<string, AuthzRole>;
  catalog: CapabilityCatalog | null;
  onLevelCreated: () => void;
  users: UserSummary[];
  directory: Directory;
  busy: string | null;
  mutate: Mutate;
  onDeleted: () => void;
}) {
  const [personId, setPersonId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const nameOf = roleNamer(roles);

  const memberIds = new Set(team.members.map((member) => member.principalId));
  const addable = users.filter((user) => !memberIds.has(user.id));
  const heldRoleIds = new Set(team.roles.map((held) => held.roleId));
  /*
   * A Role a person may not hold must never be offered for a team of people. The server checks
   * this for a direct assignment and does not for a team one, and the cost is not a rejected
   * click: resolution asserts the same rule per member and fails the *entire* authority layer
   * closed when it trips, so one wrong grant here silently strips every member of everything.
   */
  const grantable = roles.filter(
    (role) =>
      !ACCOUNT_ROLE_IDS.has(role.id) &&
      !heldRoleIds.has(role.id) &&
      role.assignableTo.includes("user")
  );
  const capabilities = teamCapabilities(team, roleById);
  const deleteKey = `delete:${team.id}`;

  async function onAddMember(event: FormEvent) {
    event.preventDefault();
    if (!personId) return;
    if (await mutate(`add:${team.id}`, () => addGroupMember(team.id, personId))) setPersonId("");
  }

  async function onGrant(event: FormEvent) {
    event.preventDefault();
    if (!roleId) return;
    if (await mutate(`grant:${team.id}`, () => grantRoleToGroup(team.id, roleId))) setRoleId("");
  }

  async function onDelete() {
    if (confirming !== deleteKey) {
      setConfirming(deleteKey);
      return;
    }
    if (await mutate(deleteKey, () => deleteGroup(team.id))) onDeleted();
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Everyone in this team can</h3>
          <ExpiryNote expiresAt={team.expiresAt} />
        </div>
        <CapabilityList grants={capabilities} />
        {capabilities.length > 0 ? (
          <TechnicalDetails>
            <RawGrantList grants={capabilities} />
          </TechnicalDetails>
        ) : null}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Access this team has</h3>
        {team.roles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No access yet.</p>
        ) : (
          <ul className="space-y-2">
            {team.roles.map((held) => {
              const key = `revoke:${team.id}:${held.roleId}`;
              const role = roleById.get(held.roleId);
              return (
                <li
                  key={held.roleId}
                  className="flex flex-wrap items-start gap-3 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    {role ? (
                      <RoleCard summary={summarizeRole(role)} />
                    ) : (
                      <p className="text-sm text-foreground">{nameOf(held.roleId)}</p>
                    )}
                  </div>
                  <ExpiryNote expiresAt={held.expiresAt} />
                  {confirming === key ? (
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                      Keep it
                    </Button>
                  ) : null}
                  <Button
                    variant={confirming === key ? "destructive" : "ghost"}
                    size="sm"
                    disabled={busy === key}
                    onClick={() => {
                      if (confirming !== key) {
                        setConfirming(key);
                        return;
                      }
                      void mutate(key, () => revokeRoleFromGroup(team.id, held.roleId));
                    }}
                  >
                    {busy === key
                      ? "Removing…"
                      : confirming === key
                        ? "Yes, take it away"
                        : "Take away"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {grantable.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This team already holds every access level available.
          </p>
        ) : (
          <form className="grid gap-3 sm:grid-cols-[1fr_auto]" onSubmit={onGrant}>
            <Field label="Give this team more access">
              <Select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
                <option value="">Choose one…</option>
                {grantable.map((role) => (
                  <option key={role.id} value={role.id}>
                    {roleTitle(role.id, role.displayName)}
                  </option>
                ))}
              </Select>
            </Field>
            <FieldAction>
              <Button
                className="w-full sm:w-auto"
                type="submit"
                disabled={busy === `grant:${team.id}` || roleId.length === 0}
              >
                Add
              </Button>
            </FieldAction>
          </form>
        )}

        {/*
         * The list above is only ever as good as the levels that exist. Without this, an owner who
         * needs something none of the levels covers reaches a dead end here and has no way to know
         * that making a new one is even possible.
         */}
        {catalog ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setBuilding(true)}>
              <Plus className="size-4" />
              None of these fit — make a new level
            </Button>
            <LevelBuilder
              open={building}
              onClose={() => setBuilding(false)}
              catalog={catalog}
              onCreated={onLevelCreated}
            />
          </>
        ) : null}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">People in this team</h3>
        {team.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {team.members.map((member) => {
              const key = `remove:${team.id}:${member.principalId}`;
              const party = lookupParty(directory, member.principalId);
              return (
                <li
                  key={member.principalId}
                  className="flex flex-wrap items-center gap-2 px-3 py-2"
                >
                  <PartyLine party={party} />
                  <ExpiryNote expiresAt={member.expiresAt} />
                  {confirming === key ? (
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                  ) : null}
                  <Button
                    variant={confirming === key ? "destructive" : "ghost"}
                    size="sm"
                    disabled={busy === key}
                    onClick={() => {
                      if (confirming !== key) {
                        setConfirming(key);
                        return;
                      }
                      void mutate(key, () => removeGroupMember(team.id, member.principalId));
                    }}
                  >
                    {busy === key ? "Removing…" : confirming === key ? "Yes, remove" : "Remove"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {addable.length === 0 ? (
          <p className="text-sm text-muted-foreground">Everyone with an account is in already.</p>
        ) : (
          <form className="grid gap-3 sm:grid-cols-[1fr_auto]" onSubmit={onAddMember}>
            <Field label="Add someone">
              <Select value={personId} onChange={(event) => setPersonId(event.target.value)}>
                <option value="">Choose a person…</option>
                {addable.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name?.trim() ? `${user.name} — ${user.email}` : user.email}
                  </option>
                ))}
              </Select>
            </Field>
            <FieldAction>
              <Button
                className="w-full sm:w-auto"
                type="submit"
                disabled={busy === `add:${team.id}` || personId.length === 0}
              >
                <UserPlus aria-hidden className="size-4" />
                Add
              </Button>
            </FieldAction>
          </form>
        )}
      </section>

      <section className="space-y-3 rounded-md border border-destructive/30 p-3">
        <h3 className="text-sm font-semibold text-foreground">Delete this team</h3>
        <p className="text-sm text-muted-foreground">
          This removes team access for {team.members.length}{" "}
          {team.members.length === 1 ? "person" : "people"}.
        </p>
        <div className="flex flex-wrap gap-2">
          {confirming === deleteKey ? (
            <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
              Keep it
            </Button>
          ) : null}
          <Button
            variant={confirming === deleteKey ? "destructive" : "outline"}
            size="sm"
            disabled={busy === deleteKey}
            onClick={() => void onDelete()}
          >
            {busy === deleteKey
              ? "Deleting…"
              : confirming === deleteKey
                ? `Yes, delete and remove access for ${team.members.length}`
                : "Delete team"}
          </Button>
        </div>
      </section>
    </div>
  );
}
