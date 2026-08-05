import { apiGet, apiWrite } from "./api";

export type UserStatus = "active" | "disabled";

export type UserSummary = {
  id: string;
  email: string;
  role: "admin" | "member";
  status: UserStatus;
  mustResetPassword: boolean;
};

export async function listUsers(): Promise<UserSummary[]> {
  const body = await apiGet<{ items: UserSummary[] }>("/api/v1/users");
  return body.items;
}

// Creates a member user with a system-generated temporary password, returned once for the admin
// to share out-of-band. The new user must reset it on first login.
export async function createUser(
  email: string
): Promise<{ user: UserSummary; temporaryPassword: string }> {
  return apiWrite("POST", "/api/v1/users", { email });
}

export async function setUserStatus(id: string, status: UserStatus): Promise<UserSummary> {
  const body = await apiWrite<{ user: UserSummary }>(
    "PATCH",
    `/api/v1/users/${encodeURIComponent(id)}/status`,
    { status }
  );
  return body.user;
}
