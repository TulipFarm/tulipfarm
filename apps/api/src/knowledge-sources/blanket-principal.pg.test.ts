/**
 * The blanket Principal — "everyone in this Business" — and who is allowed to hold it.
 *
 * It is never stored as membership. The resolver expands a request's Principals to include the
 * blanket Role for a signed-in member, and for the Routine executor — a Routine is the Business
 * acting on its own behalf, so it reads what the Business as a whole may read.
 *
 * It is still not a person. `service:routine-executor` is not a `users` row, so it acquires no Team
 * and no Role, and a restricted Page — whose blanket grant has been replaced by an allowlist — stays
 * closed to it. Guests, Integrations, and an Agent running with no user behind it remain excluded
 * structurally, for the same reason.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { BLANKET_READ_PRINCIPAL, PgPrincipalResolver } from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

const BUSINESS = "tulipfarm-local";
const BLANKET = { kind: "role", id: "role-everyone" };

/** What a Routine State acts as when no participant is behind it. */
const ROUTINE_EXECUTOR = "service:routine-executor";

describe("blanket Principal resolution", () => {
  let db: PGlite;
  let resolver: PgPrincipalResolver;

  async function member(role: "member" | "admin" = "member"): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, role, created_at)
       VALUES ($1, $2, 'x', $3, now())`,
      [id, `${id}@example.test`, role]
    );
    return id;
  }

  async function resolve(
    principals: readonly { kind: string; id: string }[]
  ): Promise<readonly { kind: string; id: string }[]> {
    return resolver.resolve({ businessId: BUSINESS, principals });
  }

  /** Whether the resolved set would satisfy a Page carrying only the blanket grant. */
  async function holdsBlanket(
    principals: readonly { kind: string; id: string }[]
  ): Promise<boolean> {
    const out = await resolve(principals);
    return out.some((p) => p.kind === BLANKET.kind && p.id === BLANKET.id);
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    resolver = new PgPrincipalResolver({
      query: async <Row = Record<string, unknown>>(text: string, params?: readonly unknown[]) =>
        db.query<Row>(text, params === undefined ? undefined : [...params]),
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it("gives a signed-in member the blanket Principal", async () => {
    const alice = await member();
    expect(await holdsBlanket([{ kind: "user", id: alice }])).toBe(true);
  });

  it("gives an administrator the blanket Principal too", async () => {
    const admin = await member("admin");
    expect(await holdsBlanket([{ kind: "user", id: admin }])).toBe(true);
  });

  it("keeps the caller's own Principals alongside the blanket Role", async () => {
    const alice = await member();
    const out = await resolve([{ kind: "user", id: alice }]);
    expect(out).toContainEqual({ kind: "user", id: alice });
  });

  // Revised after ticket 17: a Routine is the Business acting on its own behalf, so it reads what
  // the Business can read. It is still not a person — it acquires no Team and no Role, so a
  // restricted Page (whose blanket grant has been replaced by an allowlist) stays closed to it.
  it("gives the blanket Principal to a Routine acting with no participant behind it", async () => {
    await member();
    expect(await holdsBlanket([{ kind: "user", id: ROUTINE_EXECUTOR }])).toBe(true);
  });

  it("gives a Routine no Team and no Role, so a restriction still excludes it", async () => {
    await member();
    const held = await resolver.resolve({
      businessId: BUSINESS,
      principals: [{ kind: "user", id: ROUTINE_EXECUTOR }],
    });
    expect(held.some((p) => p.kind === "group")).toBe(false);
    expect(held.some((p) => p.kind === "role" && p.id !== BLANKET_READ_PRINCIPAL.id)).toBe(false);
  });

  it("denies the blanket Principal to an autonomous Agent", async () => {
    await member();
    expect(await holdsBlanket([{ kind: "agent", id: randomUUID() }])).toBe(false);
  });

  it("gives the blanket Principal to an Agent acting for a member", async () => {
    const alice = await member();
    const acting = [
      { kind: "agent", id: randomUUID() },
      { kind: "user", id: alice },
    ];
    expect(await holdsBlanket(acting)).toBe(true);
  });

  it("denies the blanket Principal to a guest sender", async () => {
    await member();
    expect(await holdsBlanket([{ kind: "guest", id: randomUUID() }])).toBe(false);
  });

  it("denies the blanket Principal to an integration adapter", async () => {
    await member();
    expect(await holdsBlanket([{ kind: "integration_adapter", id: randomUUID() }])).toBe(false);
  });

  it("returns nothing for a request carrying no Principals", async () => {
    await member();
    expect(await resolve([])).toEqual([]);
  });

  it("denies the blanket Principal to a user id that is not a member", async () => {
    await member();
    expect(await holdsBlanket([{ kind: "user", id: randomUUID() }])).toBe(false);
  });

  it("survives a non-uuid user id rather than failing the whole request", async () => {
    await member();
    await expect(holdsBlanket([{ kind: "user", id: "not-a-uuid" }])).resolves.toBe(false);
  });

  it("does not add the blanket Role twice when several members are present", async () => {
    const alice = await member();
    const bob = await member();
    const out = await resolve([
      { kind: "user", id: alice },
      { kind: "user", id: bob },
    ]);
    expect(out.filter((p) => p.id === BLANKET.id)).toHaveLength(1);
  });

  it("resolves a listing of Principals without a query per Principal", async () => {
    let queries = 0;
    const counted = new PgPrincipalResolver({
      query: async <Row = Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
        queries += 1;
        return db.query<Row>(text, params === undefined ? undefined : [...params]);
      },
    });
    const ids = [await member(), await member(), await member()];
    await counted.resolve({
      businessId: BUSINESS,
      principals: ids.map((id) => ({ kind: "user", id })),
    });
    expect(queries).toBeLessThanOrEqual(3);
  });

  it("asks the database nothing when no user Principal is present", async () => {
    let queries = 0;
    const counted = new PgPrincipalResolver({
      query: async <Row = Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
        queries += 1;
        return db.query<Row>(text, params === undefined ? undefined : [...params]);
      },
    });
    await counted.resolve({ businessId: BUSINESS, principals: [{ kind: "agent", id: "a" }] });
    expect(queries).toBe(0);
  });
});

/**
 * Teams and Roles a member holds. A restriction naming a Team only works if the resolver expands a
 * member into it, and an expired membership must expand to nothing rather than to access.
 */
describe("Team and Role expansion", () => {
  let db: PGlite;
  let resolver: PgPrincipalResolver;

  async function member(): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, role, created_at)
       VALUES ($1, $2, 'x', 'member', now())`,
      [id, `${id}@example.test`]
    );
    await db.query(
      `INSERT INTO principals (business_id, id, kind, status) VALUES ($1, $2, 'user', 'active')
       ON CONFLICT DO NOTHING`,
      [BUSINESS, id]
    );
    return id;
  }

  async function team(id: string, expiresAt: string | null = null): Promise<void> {
    await db.query(
      `INSERT INTO principal_groups (business_id, id, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [BUSINESS, id, expiresAt]
    );
  }

  async function joins(userId: string, teamId: string, expiresAt: string | null = null) {
    await db.query(
      `INSERT INTO principal_group_members (business_id, group_id, principal_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [BUSINESS, teamId, userId, expiresAt]
    );
  }

  async function role(id: string): Promise<void> {
    await db.query(
      `INSERT INTO roles (business_id, id, assignable_to) VALUES ($1, $2, '{user}')
       ON CONFLICT DO NOTHING`,
      [BUSINESS, id]
    );
  }

  async function holds(userId: string): Promise<readonly string[]> {
    const out = await resolver.resolve({
      businessId: BUSINESS,
      principals: [{ kind: "user", id: userId }],
    });
    return out.map((p) => `${p.kind}:${p.id}`);
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    resolver = new PgPrincipalResolver({
      query: async <Row = Record<string, unknown>>(text: string, params?: readonly unknown[]) =>
        db.query<Row>(text, params === undefined ? undefined : [...params]),
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it("expands a member into a Team they belong to", async () => {
    const alice = await member();
    await team("engineering");
    await joins(alice, "engineering");
    expect(await holds(alice)).toContain("group:engineering");
  });

  it("does not expand a member into a Team they do not belong to", async () => {
    const alice = await member();
    await team("finance");
    expect(await holds(alice)).not.toContain("group:finance");
  });

  it("does not expand an expired Team membership", async () => {
    const alice = await member();
    await team("engineering");
    await joins(alice, "engineering", "2000-01-01T00:00:00.000Z");
    expect(await holds(alice)).not.toContain("group:engineering");
  });

  it("does not expand membership of an expired Team", async () => {
    const alice = await member();
    await team("contractors", "2000-01-01T00:00:00.000Z");
    await joins(alice, "contractors");
    expect(await holds(alice)).not.toContain("group:contractors");
  });

  it("expands a member into a Role they are assigned", async () => {
    const alice = await member();
    await role("editor");
    await db.query(
      `INSERT INTO role_assignments (business_id, principal_id, role_id) VALUES ($1, $2, 'editor')`,
      [BUSINESS, alice]
    );
    expect(await holds(alice)).toContain("role:editor");
  });

  it("does not expand an expired Role assignment", async () => {
    const alice = await member();
    await role("editor");
    await db.query(
      `INSERT INTO role_assignments (business_id, principal_id, role_id, expires_at)
       VALUES ($1, $2, 'editor', '2000-01-01T00:00:00.000Z')`,
      [BUSINESS, alice]
    );
    expect(await holds(alice)).not.toContain("role:editor");
  });

  it("still expands Teams for a member holding several at once", async () => {
    const alice = await member();
    await team("engineering");
    await team("oncall");
    await joins(alice, "engineering");
    await joins(alice, "oncall");
    const held = await holds(alice);
    expect(held).toEqual(expect.arrayContaining(["group:engineering", "group:oncall"]));
  });

  it("expands nothing for a Principal that is not a member", async () => {
    await member();
    const out = await resolver.resolve({
      businessId: BUSINESS,
      principals: [{ kind: "agent", id: randomUUID() }],
    });
    expect(out.filter((p) => p.kind === "group" || p.kind === "role")).toEqual([]);
  });
});
