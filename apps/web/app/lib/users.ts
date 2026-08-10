import { apiGet, apiWrite, type UserStatus } from "./api";

export type { UserStatus };

export type UserSummary = {
  id: string;
  email: string;
  // Null until the person sets one in their own profile — admins cannot name someone else.
  name: string | null;
  role: "admin" | "member";
  status: UserStatus;
};

// An issued invite link. `token` is shown to the admin once and never readable again — the API
// stores only its hash.
export type Invite = {
  token: string;
  expiresAt: string;
};

// The link an admin actually shares. The token rides in the fragment, which browsers never send to
// a server, so it stays out of access logs and referrer headers.
export function inviteUrl(invite: Invite): string {
  return `${window.location.origin}/accept-invite#token=${encodeURIComponent(invite.token)}`;
}

export async function listUsers(): Promise<UserSummary[]> {
  const body = await apiGet<{ items: UserSummary[] }>("/api/v1/users");
  return body.items;
}

// Creates a member account with no password and issues its invite link, returned once for the
// admin to share out-of-band. The invited person chooses their own password by redeeming it.
export async function createUser(email: string): Promise<{ user: UserSummary; invite: Invite }> {
  return apiWrite("POST", "/api/v1/users", { email });
}

// Issues a fresh link for an existing user, revoking any still outstanding. For an account that
// hasn't accepted yet this replaces a lost link; for an active one it is the recovery path.
export async function reissueInvite(id: string): Promise<Invite> {
  const body = await apiWrite<{ invite: Invite }>(
    "POST",
    `/api/v1/users/${encodeURIComponent(id)}/invite`,
    {}
  );
  return body.invite;
}

/**
 * The two statuses an admin can set. `invited` is not among them: it describes an account that has
 * never been given a password, which is a fact about the account rather than a switch to flip. The
 * API resolves a re-enabled passwordless account to `invited` on its own.
 */
export type SettableUserStatus = "active" | "disabled";

export async function setUserStatus(id: string, status: SettableUserStatus): Promise<UserSummary> {
  const body = await apiWrite<{ user: UserSummary }>(
    "PATCH",
    `/api/v1/users/${encodeURIComponent(id)}/status`,
    { status }
  );
  return body.user;
}
