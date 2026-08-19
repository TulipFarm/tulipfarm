/**
 * The picker behind the restrict dialog.
 *
 * Every other directory in this API is admin-only, which left an ordinary member able to restrict
 * their own Page but unable to look up who to share it with. This route closes that, and the
 * deliberate trade is written down in the ticket: within one Business the staff list is not itself
 * a secret. What is a secret is everything hanging off a person — their role, their Team
 * memberships, their grants — so this returns an identifier and a label and nothing else.
 */
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRequireAuthorization } from "../authz/route-gate";
import { makeMigratedPglite } from "../test/pglite";
import { registerSubjectRoutes, SubjectDirectory } from "./subject-directory";

describe("naming someone to share with", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let caller: string;

  async function addUser(name: string | null, email: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', $3, 'member', 'active', now())`,
      [id, email, name]
    );
    return id;
  }

  async function addTeam(team: string): Promise<void> {
    await db.query(
      `INSERT INTO principal_groups (business_id, id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [DEPLOYMENT_BUSINESS_ID, team]
    );
  }

  async function addRole(role: string): Promise<void> {
    await db.query(
      `INSERT INTO roles (business_id, id, assignable_to) VALUES ($1, $2, ARRAY['user'])
       ON CONFLICT DO NOTHING`,
      [DEPLOYMENT_BUSINESS_ID, role]
    );
  }

  const list = () => app.inject({ method: "GET", url: "/api/v1/knowledge/subjects" });

  beforeEach(async () => {
    db = await makeMigratedPglite();
    caller = await addUser("Caller", "caller@example.com");
    app = Fastify();
    registerSubjectRoutes(
      app,
      async (req) => {
        req.user = {
          _id: caller,
          email: "caller@example.com",
          passwordHash: "x",
          name: "Caller",
          role: "member",
          status: "active" as const,
          createdAt: new Date(),
        };
        req.principal = {
          id: caller,
          kind: "user",
          businessId: DEPLOYMENT_BUSINESS_ID,
          credential: "session",
          authMethods: ["password"],
          authenticatedAt: new Date(),
          role: "member",
        };
      },
      makeRequireAuthorization(),
      new SubjectDirectory(db)
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("names every active User, Team, and Role a member could share with", async () => {
    await addUser("Ana Ruiz", "ana@example.com");
    await addTeam("finance");
    await addRole("editor");

    const res = await list();
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.users.map((u: { label: string }) => u.label)).toContain("Ana Ruiz");
    expect(body.teams.map((t: { id: string }) => t.id)).toContain("finance");
    expect(body.roles.map((r: { id: string }) => r.id)).toContain("editor");
  });

  it("falls back to the email when a User has no display name, so they stay shareable", async () => {
    await addUser(null, "noname@example.com");

    const labels = (await list()).json().users.map((u: { label: string }) => u.label);
    expect(labels).toContain("noname@example.com");
  });

  it("discloses an identifier and a label and nothing else about a person", async () => {
    await addUser("Ana Ruiz", "ana@example.com");

    const users = (await list()).json().users as Array<Record<string, unknown>>;
    const ana = users.find((u) => u.label === "Ana Ruiz");
    expect(ana).toBeDefined();
    // A named person's role, status and membership are not the picker's business.
    expect(Object.keys(ana ?? {}).sort()).toEqual(["id", "kind", "label"]);
  });

  it("omits a deactivated User, because sharing with them grants nothing", async () => {
    const gone = await addUser("Gone Away", "gone@example.com");
    await db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [gone]);

    const labels = (await list()).json().users.map((u: { label: string }) => u.label);
    expect(labels).not.toContain("Gone Away");
  });

  it("refuses an unauthenticated caller", async () => {
    const bare = Fastify();
    registerSubjectRoutes(
      bare,
      async (_req, reply) => {
        await reply.code(401).send({ error: "unauthorized" });
      },
      makeRequireAuthorization(),
      new SubjectDirectory(db)
    );
    await bare.ready();
    const res = await bare.inject({ method: "GET", url: "/api/v1/knowledge/subjects" });
    expect(res.statusCode).toBe(401);
    await bare.close();
  });

  it("lets a deployment refuse the directory outright", async () => {
    const closed = Fastify();
    registerSubjectRoutes(
      closed,
      async (req) => {
        req.principal = {
          id: caller,
          kind: "user",
          businessId: DEPLOYMENT_BUSINESS_ID,
          credential: "session",
          authMethods: ["password"],
          authenticatedAt: new Date(),
          role: "member",
        };
      },
      makeRequireAuthorization({
        authorize: async (_p, r) => r.action !== "knowledge_subject.list",
      }),
      new SubjectDirectory(db)
    );
    await closed.ready();
    expect(
      (await closed.inject({ method: "GET", url: "/api/v1/knowledge/subjects" })).statusCode
    ).toBe(403);
    await closed.close();
  });
});
