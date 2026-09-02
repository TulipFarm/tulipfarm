import { Lock, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { Select } from "~/components/ui/select";
import type { Party } from "~/lib/access-directory";
import { ACCOUNT_STATUS, roleNamer, roleTitle, summarizeRole } from "~/lib/access-language";
import {
  type AuthzRole,
  assignRole,
  isLayerFault,
  LAYER_EMPTY_REASON_LABEL,
  type LayerEmptyReason,
  revokeRole,
} from "~/lib/authz";
import { useSessionUser } from "~/lib/use-session-user";
import { type Invite, reissueInvite, setUserStatus, type UserStatus } from "~/lib/users";
import type {
  KeeperSource,
  PersonAccess,
  SelectedAccess,
} from "~/routes/_app.business.access._index";
import {
  CapabilityList,
  ExpiryNote,
  PartyAvatar,
  PartyLine,
  RawGrantList,
  RoleCard,
  TechnicalDetails,
} from "./access-bits";

type MutateAccess = <T>(key: string, operation: () => Promise<T>) => Promise<T | null>;

export function PersonRow({
  person,
  heldTitles,
  onManage,
}: {
  person: PersonAccess;
  heldTitles: string[];
  onManage: (principalId: string) => void;
}) {
  const status = ACCOUNT_STATUS[person.status];

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <PartyLine party={person.party} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={person.accountRole === "admin" ? "primary" : "neutral"}>
          {roleTitle(person.accountRole)}
        </Badge>
        {heldTitles.slice(0, 2).map((title) => (
          <Badge key={title} variant="info">
            {title}
          </Badge>
        ))}
        {heldTitles.length > 2 ? <Badge variant="neutral">+{heldTitles.length - 2}</Badge> : null}
        {status.badge ? <Badge variant={status.tone}>{status.badge}</Badge> : null}
      </div>
      <Button variant="outline" size="sm" onClick={() => onManage(person.party.principalId)}>
        Manage
      </Button>
    </div>
  );
}

export function PersonDetail({
  person,
  otherParty,
  access,
  roles,
  keepers,
  busy,
  mutate,
  onIssued,
  accountRoleIds,
  isLastKeeper,
  teamTitle,
  expiryIso,
}: {
  person: PersonAccess | null;
  otherParty: Party | null;
  access: SelectedAccess | null;
  roles: AuthzRole[];
  keepers: KeeperSource[];
  busy: string | null;
  mutate: MutateAccess;
  onIssued: (email: string, invite: Invite | null) => void;
  accountRoleIds: ReadonlySet<string>;
  isLastKeeper: (keepers: KeeperSource[], principalId: string, roleId: string) => boolean;
  teamTitle: (teamId: string) => string;
  expiryIso: (value: string) => string | undefined;
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
      !accountRoleIds.has(role.id) &&
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
  mutate: MutateAccess;
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
