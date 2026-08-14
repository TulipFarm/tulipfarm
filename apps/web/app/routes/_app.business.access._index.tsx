/* User-role Rows are trigger-owned, and team-inherited access cannot be removed here. */

import {
  type ClientLoaderFunctionArgs,
  Link,
  type MetaFunction,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "@remix-run/react";
import { Lock, Pencil, Plus, Search, Trash2, TriangleAlert, UserPlus, Users } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import {
  CapabilityList,
  ExpiryNote,
  PartyAvatar,
  PartyLine,
  RawGrantList,
  RoleCard,
  TechnicalDetails,
} from "~/components/access/access-bits";
import { type EditableLevel, LevelBuilder } from "~/components/access/level-builder";
import { AccessTabs } from "~/components/access-tabs";
import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { CopyField } from "~/components/ui/copy-field";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Modal } from "~/components/ui/modal";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import { Sheet } from "~/components/ui/sheet";
import {
  buildDirectory,
  type Directory,
  lookupParty,
  matchesQuery,
  type Party,
} from "~/lib/access-directory";
import { ACCOUNT_STATUS, roleNamer, roleTitle, summarizeRole } from "~/lib/access-language";
import { ApiError } from "~/lib/api";
import {
  type AuthzGroupDetail,
  type AuthzRole,
  assignRole,
  type CapabilityCatalog,
  deleteLevel,
  type EffectiveGrants,
  getEffectiveGrants,
  getGroup,
  isLayerFault,
  LAYER_EMPTY_REASON_LABEL,
  type LayerEmptyReason,
  listCapabilities,
  listGroups,
  listRoleAssignees,
  listRoles,
  revokeRole,
} from "~/lib/authz";
import { useSessionUser } from "~/lib/use-session-user";
import {
  createUser,
  type Invite,
  inviteUrl,
  listUsers,
  reissueInvite,
  setUserStatus,
  type UserStatus,
} from "~/lib/users";

export const meta: MetaFunction = () => [{ title: "People · Access · tulipfarm" }];

/** Trigger-owned account Roles are shown but not grantable here. */
const ACCOUNT_ROLE_IDS: ReadonlySet<string> = new Set(["admin", "member"]);

type SelectedAccess =
  | { status: "ok"; effective: EffectiveGrants }
  | { status: "error"; message: string };

export async function clientLoader({ request }: ClientLoaderFunctionArgs) {
  const selectedId = new URL(request.url).searchParams.get("person")?.trim() ?? "";

  const [users, { roles }, { groups }, catalog] = await Promise.all([
    listUsers(),
    listRoles(),
    listGroups(),
    // The catalog is what makes "create a level" possible at all. It is admin-only, and this page
    // already is, but a deployment without the authoring routes wired still renders — the builder
    // simply is not offered, rather than the whole page failing.
    listCapabilities().catch(() => null),
  ]);
  const [assignments, teams, selectedAccess] = await Promise.all([
    Promise.all(
      roles.map(async (role) => ({
        roleId: role.id,
        assignees: (await listRoleAssignees(role.id)).assignees,
      }))
    ),
    Promise.all(groups.map((group) => getGroup(group.id))),
    loadSelected(selectedId),
  ]);

  return { users, roles, assignments, teams, selectedId, selectedAccess, catalog };
}

async function loadSelected(principalId: string): Promise<SelectedAccess | null> {
  if (!principalId) return null;
  try {
    return { status: "ok", effective: await getEffectiveGrants(principalId) };
  } catch (err) {
    return { status: "error", message: errorMessage(err) };
  }
}

type LoaderData = Awaited<ReturnType<typeof clientLoader>>;

/** Everything one row needs, assembled once rather than re-derived per render. */
type PersonAccess = {
  party: Party;
  /** From `users.role`. Read-only here — see the module comment. */
  accountRole: string;
  /** Whether they can sign in at all, which no amount of granted access can substitute for. */
  status: UserStatus;
  /** Roles granted to this person alone, excluding the account-derived pair. */
  directRoles: Array<{ roleId: string; expiresAt: string | null }>;
  /** Teams this person belongs to, and the Roles those teams carry. */
  teams: Array<{ id: string; roleIds: string[] }>;
};

export default function AccessPeople() {
  const data = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [issued, setIssued] = useState<{ email: string; invite: Invite } | null>(null);

  const directory = useMemo(() => buildDirectory(data.users), [data.users]);
  const people = useMemo(() => buildPeople(data, directory), [data, directory]);
  const others = useMemo(() => buildNonPeople(data, directory), [data, directory]);
  const keepers = useMemo(() => findKeepers(data, people), [data, people]);
  const visible = people.filter((person) => matchesQuery(person.party, query));

  const selected = people.find((person) => person.party.principalId === data.selectedId) ?? null;
  const selectedOther = others.find((party) => party.principalId === data.selectedId) ?? null;

  function select(principalId: string | null) {
    setError(null);
    const next = new URLSearchParams(searchParams);
    if (principalId) {
      next.set("person", principalId);
    } else {
      next.delete("person");
    }
    setSearchParams(next);
  }

  async function mutate<T>(key: string, operation: () => Promise<T>): Promise<T | null> {
    setError(null);
    setBusy(key);
    try {
      const result = await operation();
      revalidator.revalidate();
      return result;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  /** Invite links are shown once, so store them above both modals. */
  function show(email: string, invite: Invite | null) {
    if (invite) setIssued({ email, invite });
  }

  const loadingSelection = navigation.state === "loading";

  return (
    <div className="space-y-6">
      <AccessTabs />

      {error ? <FormStatus tone="error">{error}</FormStatus> : null}

      {issued ? <IssuedLink issued={issued} onDismiss={() => setIssued(null)} /> : null}

      <Panel
        title="Who can do what"
        description="Everyone who can sign in, and what each of them is allowed to do."
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                className="w-56 pl-8"
                placeholder="Search people"
                aria-label="Search people"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Button onClick={() => setInviting(true)}>
              <UserPlus aria-hidden className="size-4" />
              Invite someone
            </Button>
          </div>
        }
        flush
      >
        {people.length === 0 ? (
          <PanelEmpty>Nobody yet. Invite the first person to get started.</PanelEmpty>
        ) : visible.length === 0 ? (
          <PanelEmpty>Nobody matches “{query}”.</PanelEmpty>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((person) => (
              <li key={person.party.principalId}>
                <PersonRow person={person} roles={data.roles} onManage={select} />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {others.length > 0 ? (
        <Panel
          title="Apps and automations"
          description="These are not people. They hold access so an assistant, a routine or another system can act on its own."
          flush
        >
          <ul className="divide-y divide-border">
            {others.map((party) => (
              <li key={party.principalId} className="flex items-center gap-3 px-4 py-3">
                <PartyLine party={party} />
                <Button variant="outline" size="sm" onClick={() => select(party.principalId)}>
                  View access
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <LevelsPanel roles={data.roles} catalog={data.catalog} onChanged={revalidator.revalidate} />

      <Modal
        open={inviting}
        onClose={() => setInviting(false)}
        title="Invite someone"
        className="max-w-lg"
      >
        <InviteForm
          busy={busy === "invite"}
          onInvite={async (email) => {
            const result = await mutate("invite", () => createUser(email));
            if (!result) return false;
            show(result.user.email, result.invite);
            setInviting(false);
            return true;
          }}
        />
      </Modal>

      <Sheet
        open={Boolean(data.selectedId)}
        onClose={() => select(null)}
        title={
          selected
            ? `${selected.party.name}'s access`
            : selectedOther
              ? `${selectedOther.name}'s access`
              : "Access"
        }
        className="sm:max-w-xl"
      >
        {loadingSelection ? (
          <p className="py-6 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <PersonDetail
            person={selected}
            otherParty={selectedOther}
            access={data.selectedAccess}
            roles={data.roles}
            keepers={keepers}
            busy={busy}
            mutate={mutate}
            onIssued={show}
          />
        )}
      </Sheet>
    </div>
  );
}

/** Invite links are unrecoverable after first display because the API stores only a hash. */
function IssuedLink({
  issued,
  onDismiss,
}: {
  issued: { email: string; invite: Invite };
  onDismiss: () => void;
}) {
  return (
    <Panel className="border-primary/40">
      <div className="space-y-2">
        <p className="text-sm text-foreground">
          Send this link to <strong>{issued.email}</strong> yourself. It is not shown again, and it
          stops working on {new Date(issued.invite.expiresAt).toLocaleDateString()}.
        </p>
        <div className="flex items-center gap-2">
          <CopyField
            value={inviteUrl(issued.invite)}
            label="invite link"
            className="min-w-0 flex-1"
          />
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function InviteForm({
  busy,
  onInvite,
}: {
  busy: boolean;
  onInvite: (email: string) => Promise<boolean>;
}) {
  const [email, setEmail] = useState("");

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await onInvite(email.trim())) setEmail("");
      }}
    >
      <p className="text-sm text-muted-foreground">
        They get a link and choose their own password, so you never handle it. They start with
        everyday access — give them more once they are in.
      </p>
      <Field label="Email" required>
        <Input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com"
        />
      </Field>
      <Button type="submit" disabled={busy || email.trim().length === 0}>
        {busy ? "Inviting…" : "Create the invite link"}
      </Button>
    </form>
  );
}

function LevelsPanel({
  roles,
  catalog,
  onChanged,
}: {
  roles: AuthzRole[];
  catalog: CapabilityCatalog | null;
  onChanged: () => void;
}) {
  const [building, setBuilding] = useState(false);
  const [editing, setEditing] = useState<EditableLevel | undefined>(undefined);
  return (
    <Panel
      title="What each level of access means"
      description="Levels are named bundles of things people can do. Create one for each kind of job in your business."
      flush
      actions={
        catalog ? (
          <Button variant="outline" size="sm" onClick={() => setBuilding(true)}>
            <Plus className="size-4" />
            New level
          </Button>
        ) : null
      }
    >
      <LevelBuilder
        open={building}
        onClose={() => {
          setBuilding(false);
          setEditing(undefined);
        }}
        catalog={catalog}
        onCreated={onChanged}
        editing={editing}
      />
      {roles.length === 0 ? (
        <PanelEmpty>No access levels defined.</PanelEmpty>
      ) : (
        <ul className="divide-y divide-border">
          {roles.map((role) => (
            <li key={role.id} className="space-y-2 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <RoleCard summary={summarizeRole(role)} className="min-w-0 flex-1" />
                {role.source === "authored" && role.slug ? (
                  <div className="flex shrink-0 items-start gap-1">
                    <EditLevelButton
                      role={role}
                      slug={role.slug}
                      onEdit={(level) => {
                        setEditing(level);
                        setBuilding(true);
                      }}
                    />
                    <DeleteLevelButton role={role} slug={role.slug} onDeleted={onChanged} />
                  </div>
                ) : null}
              </div>
              <TechnicalDetails>
                <RawGrantList grants={role.grants} />
              </TechnicalDetails>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Only authored levels can be edited; built-ins have no Soul artifact to rewrite. */
function EditLevelButton({
  role,
  slug,
  onEdit,
}: {
  role: AuthzRole;
  slug: string;
  onEdit: (level: EditableLevel) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() =>
        onEdit({
          slug,
          displayName: role.displayName ?? slug,
          capabilities: role.grants
            .filter((grant) => grant.effect === "allow")
            .map((grant) => grant.action),
        })
      }
    >
      <Pencil className="size-4" />
      Edit
    </Button>
  );
}

/** Deleting a level cascades to every holder; withhold the button when `slug` is absent. */
function DeleteLevelButton({
  role,
  slug,
  onDeleted,
}: {
  role: AuthzRole;
  slug: string;
  onDeleted: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteLevel(slug);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
      setArmed(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shrink-0 space-y-1 text-right">
      <Button
        variant={armed ? "destructive" : "ghost"}
        size="sm"
        onClick={remove}
        disabled={busy}
        aria-label={`Delete the ${roleTitle(role.id, role.displayName)} level`}
      >
        <Trash2 className="size-4" />
        {busy ? "Deleting…" : armed ? "Yes, delete it" : "Delete"}
      </Button>
      {armed && !busy ? (
        <p className="max-w-48 text-xs text-muted-foreground">
          Everybody with this level loses it straight away.
        </p>
      ) : null}
      {error ? <p className="text-xs text-status-danger">{error}</p> : null}
    </div>
  );
}

function PersonRow({
  person,
  roles,
  onManage,
}: {
  person: PersonAccess;
  roles: AuthzRole[];
  onManage: (principalId: string) => void;
}) {
  const held = heldRoleTitles(person, roles);
  const status = ACCOUNT_STATUS[person.status];

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <PartyLine party={person.party} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={person.accountRole === "admin" ? "primary" : "neutral"}>
          {roleTitle(person.accountRole)}
        </Badge>
        {held.slice(0, 2).map((title) => (
          <Badge key={title} variant="info">
            {title}
          </Badge>
        ))}
        {held.length > 2 ? <Badge variant="neutral">+{held.length - 2}</Badge> : null}
        {status.badge ? <Badge variant={status.tone}>{status.badge}</Badge> : null}
      </div>
      <Button variant="outline" size="sm" onClick={() => onManage(person.party.principalId)}>
        Manage
      </Button>
    </div>
  );
}

function PersonDetail({
  person,
  otherParty,
  access,
  roles,
  keepers,
  busy,
  mutate,
  onIssued,
}: {
  person: PersonAccess | null;
  otherParty: Party | null;
  access: SelectedAccess | null;
  roles: AuthzRole[];
  keepers: KeeperSource[];
  busy: string | null;
  mutate: <T>(key: string, operation: () => Promise<T>) => Promise<T | null>;
  onIssued: (email: string, invite: Invite | null) => void;
}) {
  const sessionUser = useSessionUser();
  const [roleId, setRoleId] = useState("");
  const [until, setUntil] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  const selectedParty = person?.party ?? otherParty;
  if (!selectedParty) return <p className="py-6 text-sm text-muted-foreground">Nobody selected.</p>;
  const party: Party = selectedParty;

  const roleById = new Map(roles.map((role) => [role.id, role]));
  const nameOf = roleNamer(roles);
  const alreadyHeld = new Set(person?.directRoles.map((held) => held.roleId) ?? []);
  /* Person-ineligible Roles are hidden only for people; other kinds are server-checked. */
  const grantable = roles.filter(
    (role) =>
      !ACCOUNT_ROLE_IDS.has(role.id) &&
      !alreadyHeld.has(role.id) &&
      (person === null || role.assignableTo.includes("user"))
  );
  const chosen = roleById.get(roleId);
  const isSelf = sessionUser?.id === party.principalId;

  /* Warn only when a direct Role is the single source keeping the current user unrestricted. */
  const mySources = keepers.filter((source) => source.principalId === party.principalId);
  const onlySource = mySources.length === 1 ? mySources[0] : null;
  const soleRoleId = onlySource?.key.startsWith("role:")
    ? onlySource.key.slice("role:".length)
    : null;
  const warnSelf =
    isSelf && soleRoleId !== null && !isLastKeeper(keepers, party.principalId, soleRoleId);

  async function onGive(event: FormEvent) {
    event.preventDefault();
    if (!roleId) return;
    const saved = await mutate("give", () =>
      assignRole(roleId, party.principalId, expiryIso(until))
    );
    if (saved) {
      setRoleId("");
      setUntil("");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <PartyAvatar party={party} className="size-10 text-sm" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{party.name}</p>
          <p className="truncate text-xs text-muted-foreground">{party.detail}</p>
        </div>
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">What they can do today</h3>
        {access === null ? (
          <p className="text-sm text-muted-foreground">Nothing loaded.</p>
        ) : access.status === "error" ? (
          <FormStatus tone="error">{access.message}</FormStatus>
        ) : (
          <>
            {access.effective.grants.length === 0 && access.effective.emptyReason ? (
              <EmptyReason reason={access.effective.emptyReason} status={person?.status} />
            ) : null}
            <CapabilityList grants={access.effective.grants} />
            <TechnicalDetails>
              <RawGrantList grants={access.effective.grants} />
            </TechnicalDetails>
          </>
        )}
      </section>

      {person ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Where it comes from</h3>

          <AccountBlock person={person} busy={busy} mutate={mutate} onIssued={onIssued} />

          {person.teams.length > 0 ? (
            <div className="rounded-md border border-border px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-foreground">
                  In {person.teams.length === 1 ? "team" : "teams"}:{" "}
                  {person.teams.map((team) => teamTitle(team.id)).join(", ")}
                </span>
                <Button variant="link" size="sm" asChild>
                  <Link to="/business/access/teams">Manage teams</Link>
                </Button>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Access from a team belongs to the team. Remove them from it to take it away.
              </p>
            </div>
          ) : null}

          {person.directRoles.length > 0 ? (
            <ul className="space-y-2">
              {person.directRoles.map((held) => {
                const key = `revoke:${held.roleId}`;
                const summary = roleById.get(held.roleId);
                const last = isLastKeeper(keepers, party.principalId, held.roleId);
                return (
                  <li
                    key={held.roleId}
                    className="flex flex-wrap items-start gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      {summary ? (
                        <RoleCard summary={summarizeRole(summary)} />
                      ) : (
                        <p className="text-sm text-foreground">{nameOf(held.roleId)}</p>
                      )}
                      {last ? (
                        <p className="mt-1 flex items-start gap-2 text-xs text-muted-foreground">
                          <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                          This is the last full access in the business. Give it to somebody else
                          first, then it can be taken away here.
                        </p>
                      ) : null}
                    </div>
                    <ExpiryNote expiresAt={held.expiresAt} />
                    {last ? null : (
                      <>
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
                            void mutate(key, () => revokeRole(held.roleId, party.principalId));
                          }}
                        >
                          {busy === key
                            ? "Removing…"
                            : confirming === key
                              ? "Yes, take it away"
                              : "Take away"}
                        </Button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing extra has been given to them on their own.
            </p>
          )}

          {warnSelf ? (
            <p className="flex items-start gap-2 text-xs text-status-warning">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              This is you, and this is the only thing giving you access to this page. Take it away
              and you will need somebody else to give it back.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Give more access</h3>
        {grantable.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            There is nothing left to give. New access levels are written in your Soul repository.
          </p>
        ) : (
          <form className="space-y-3" onSubmit={onGive}>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <Field label="Access level" required>
                <Select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
                  <option value="">Choose one…</option>
                  {grantable.map((role) => (
                    <option key={role.id} value={role.id}>
                      {roleTitle(role.id, role.displayName)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Until (optional)" help="Leave empty to keep it indefinitely.">
                <Input
                  type="date"
                  value={until}
                  onChange={(event) => setUntil(event.target.value)}
                />
              </Field>
            </div>
            {chosen ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
                <RoleCard summary={summarizeRole(chosen)} />
              </div>
            ) : null}
            <Button type="submit" disabled={busy === "give" || roleId.length === 0}>
              {busy === "give" ? "Giving…" : "Give access"}
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}

/** Account status explains empty access before generic `not-authenticatable` faults. */
function EmptyReason({ reason, status }: { reason: LayerEmptyReason; status?: UserStatus }) {
  const explained =
    reason === "not-authenticatable" && (status === "invited" || status === "disabled");

  if (explained) {
    return (
      <p className="text-sm text-muted-foreground">
        {status === "invited"
          ? "They have not opened their invite yet, so nothing applies to them so far."
          : "This account is turned off, so nothing applies until it is turned back on."}
      </p>
    );
  }

  return isLayerFault(reason) ? (
    <FormStatus tone="error">{LAYER_EMPTY_REASON_LABEL[reason]}</FormStatus>
  ) : (
    <p className="text-sm text-muted-foreground">{LAYER_EMPTY_REASON_LABEL[reason]}</p>
  );
}

/** Account Role is trigger-owned and not editable here; admins cannot reset or suspend admins. */
function AccountBlock({
  person,
  busy,
  mutate,
  onIssued,
}: {
  person: PersonAccess;
  busy: string | null;
  mutate: <T>(key: string, operation: () => Promise<T>) => Promise<T | null>;
  onIssued: (email: string, invite: Invite | null) => void;
}) {
  const [confirmingOff, setConfirmingOff] = useState(false);
  const status = ACCOUNT_STATUS[person.status];
  const isAdmin = person.accountRole === "admin";
  const turningOff = status.nextStatus === "disabled";

  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-foreground">
          Their account: {roleTitle(person.accountRole)}
        </span>
        {status.badge ? <Badge variant={status.tone}>{status.badge}</Badge> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {isAdmin
          ? "This level comes with the account. Another admin's sign-in cannot be changed from here."
          : "This level comes with the account itself, and is not something to give or take away."}
      </p>

      {isAdmin ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {status.linkLabel ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy === "invite-link"}
              onClick={() =>
                void mutate("invite-link", () => reissueInvite(person.party.principalId)).then(
                  (invite) => onIssued(person.party.detail, invite)
                )
              }
            >
              {busy === "invite-link" ? "Making a link…" : status.linkLabel}
            </Button>
          ) : null}
          {confirmingOff ? (
            <Button variant="ghost" size="sm" onClick={() => setConfirmingOff(false)}>
              Leave it on
            </Button>
          ) : null}
          <Button
            variant={confirmingOff ? "destructive" : "ghost"}
            size="sm"
            disabled={busy === "status"}
            onClick={() => {
              // Turning an account off ends their session everywhere. Turning one back on cannot
              // surprise anyone, so it needs no second thought.
              if (turningOff && !confirmingOff) {
                setConfirmingOff(true);
                return;
              }
              setConfirmingOff(false);
              void mutate("status", () =>
                setUserStatus(person.party.principalId, status.nextStatus)
              );
            }}
          >
            {busy === "status"
              ? "Saving…"
              : confirmingOff
                ? "Yes, turn it off"
                : status.toggleLabel}
          </Button>
        </div>
      )}
      {confirmingOff ? (
        <p className="text-xs text-muted-foreground">
          They are signed out everywhere and cannot sign back in. Their access is kept, so turning
          the account on again restores it.
        </p>
      ) : null}
    </div>
  );
}

// ── Derivation ───────────────────────────────────────────────────────────────
function buildPeople(data: LoaderData, directory: Directory): PersonAccess[] {
  return data.users.map((user) => ({
    party: lookupParty(directory, user.id),
    accountRole: user.role,
    status: user.status,
    directRoles: data.assignments
      .filter((entry) => !ACCOUNT_ROLE_IDS.has(entry.roleId))
      .flatMap((entry) =>
        entry.assignees
          .filter((assignee) => assignee.principalId === user.id)
          .map((assignee) => ({ roleId: entry.roleId, expiresAt: assignee.expiresAt }))
      ),
    teams: teamsFor(data.teams, user.id),
  }));
}

function teamsFor(teams: AuthzGroupDetail[], principalId: string) {
  return teams
    .filter((team) => team.members.some((member) => member.principalId === principalId))
    .map((team) => ({ id: team.id, roleIds: team.roles.map((role) => role.roleId) }));
}

/** Last-unrestricted checks must count direct, account-derived, and team-derived sources. */
type KeeperSource = { principalId: string; key: string };

function findKeepers(data: LoaderData, people: PersonAccess[]): KeeperSource[] {
  const unrestricted = new Set(
    data.roles.filter((role) => summarizeRole(role).unrestricted).map((role) => role.id)
  );
  const sources: KeeperSource[] = [];

  for (const person of people) {
    const id = person.party.principalId;
    // A disabled or never-opened account cannot sign in, so it can rescue nobody.
    if (person.status !== "active") continue;
    if (unrestricted.has(person.accountRole)) sources.push({ principalId: id, key: "account" });
    for (const held of person.directRoles) {
      if (unrestricted.has(held.roleId))
        sources.push({ principalId: id, key: `role:${held.roleId}` });
    }
    for (const team of person.teams) {
      for (const roleId of team.roleIds) {
        if (unrestricted.has(roleId)) sources.push({ principalId: id, key: `team:${team.id}` });
      }
    }
  }

  return sources;
}

/** Whether taking this Role from this person would leave nobody able to give it back. */
function isLastKeeper(keepers: KeeperSource[], principalId: string, roleId: string): boolean {
  if (keepers.length === 0) return false;
  return keepers.every(
    (source) => source.principalId === principalId && source.key === `role:${roleId}`
  );
}

/** Non-user principals can hold direct Roles, team access, or both, so collect both sources. */
function buildNonPeople(data: LoaderData, directory: Directory): Party[] {
  const ids = new Set<string>();
  for (const entry of data.assignments) {
    for (const assignee of entry.assignees) ids.add(assignee.principalId);
  }
  for (const team of data.teams) {
    for (const member of team.members) ids.add(member.principalId);
  }

  return [...ids]
    .filter((id) => !directory.has(id))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => lookupParty(directory, id));
}

function heldRoleTitles(person: PersonAccess, roles: AuthzRole[]): string[] {
  const known = new Set(roles.map((role) => role.id));
  const nameOf = roleNamer(roles);
  const titles = new Set<string>();
  for (const held of person.directRoles) titles.add(nameOf(held.roleId));
  for (const team of person.teams) {
    for (const roleId of team.roleIds) {
      if (!ACCOUNT_ROLE_IDS.has(roleId) && known.has(roleId)) titles.add(nameOf(roleId));
    }
  }
  return [...titles].sort((a, b) => a.localeCompare(b));
}

/** Teams are stored under a slug; show the words back. */
export function teamTitle(teamId: string): string {
  const words = teamId.replaceAll(/[._-]+/g, " ").trim();
  if (words.length === 0) return teamId;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Date-only expiry means end of that local day. */
function expiryIso(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const date = new Date(`${trimmed}T23:59:59`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function errorMessage(err: unknown) {
  if (err instanceof ApiError) {
    return err.status === 403 ? "You are not an admin of this business." : err.message;
  }
  return "Could not reach the API.";
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <div className="space-y-6">
      <AccessTabs />
      <FormStatus tone="error">{errorMessage(error)}</FormStatus>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Users aria-hidden className="size-4" />
        Only an admin can see who has access or change it.
      </p>
    </div>
  );
}
