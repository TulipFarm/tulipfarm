import { describe, expect, it } from "vitest";
import type { SessionUser } from "~/lib/api";
import { isBusinessAdmin } from "./use-session-user";

function user(overrides: Partial<SessionUser>): SessionUser {
  return {
    id: "u1",
    email: "someone@example.com",
    name: null,
    role: "member",
    status: "active",
    navigation: { visiblePaths: [] },
    ...overrides,
  };
}

describe("isBusinessAdmin", () => {
  /*
   * The `Owner` access level is the only promotion the product offers, and it never rewrites the
   * account role — so deriving admin from `role` alone left a granted Owner locked out of every
   * admin surface the UI guards (#408).
   */
  it("trusts the session's own answer over the account role", () => {
    expect(isBusinessAdmin(user({ role: "member", isAdmin: true }))).toBe(true);
  });

  it("keeps everyday access out", () => {
    expect(isBusinessAdmin(user({ role: "member", isAdmin: false }))).toBe(false);
  });

  it("still admits the account admin", () => {
    expect(isBusinessAdmin(user({ role: "admin", isAdmin: true }))).toBe(true);
  });

  it("fails closed when the API says nothing", () => {
    expect(isBusinessAdmin(user({ role: "admin" }))).toBe(false);
    expect(isBusinessAdmin(undefined)).toBe(false);
  });
});
