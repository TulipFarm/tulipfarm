/**
 * The Space-taking Tools obey the Space gate, not just the Page gate.
 *
 * The REST twins of these Tools call `canReadSpace` first and answer 404 for a restricted Space,
 * because "it exists but is empty for you" is itself a disclosure. The Tools filtered only the
 * *pages*, so a fully restricted Space still rendered — an empty listing and `success: true`,
 * which a non-existent Space never produces. That difference is the leak.
 *
 * These Tools also reach `uuid` columns, so an id that cannot name a row must not come back as an
 * `internal_error` carrying a raw Postgres message: that distinguishes "malformed" from "absent"
 * and fingerprints the id scheme.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { EmbeddingPort } from "@tulipfarm/knowledge";
import {
  KNOWLEDGE_TOOLS,
  KnowledgeService,
  type KnowledgeToolContext,
  PageReadGate,
  PageRetrievalService,
  PgKnowledgeAclRepo,
  PgKnowledgeChunkRepo,
  PgKnowledgeLinksRepo,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
  PgKnowledgeSpaceOverrideRepo,
  PgKnowledgeSpaceRepo,
} from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

const BUSINESS = "tulipfarm-local";

function lexicalOnly(): EmbeddingPort {
  return {
    isAvailable: () => false,
    embedMany: async (values) => ({ embeddings: values.map(() => [0, 0, 0]), dimension: 3 }),
    getActive: () => null,
    getDimension: () => null,
    pendingReindex: () => false,
    clearPendingReindex: () => {},
  };
}

const byName = Object.fromEntries(KNOWLEDGE_TOOLS.map((t) => [t.name, t]));

type Result = { success: boolean; data?: unknown; error?: unknown };

describe("Space-taking Tools obey the Space gate", () => {
  let db: PGlite;
  let service: KnowledgeService;
  let gate: PageReadGate;
  let acl: PgKnowledgeAclRepo;
  let overrides: PgKnowledgeSpaceOverrideRepo;
  let insider: string;
  let outsider: string;
  let spaceId: string;

  const ctx = (userId: string): KnowledgeToolContext => ({ userId, service, pageGate: gate });

  const call = (name: string, args: object, userId: string): Promise<Result> =>
    byName[name].handler(args, ctx(userId)) as Promise<Result>;

  async function addMember(): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, role, created_at)
       VALUES ($1, $2, 'x', 'member', now())`,
      [id, `${id}@example.test`]
    );
    return id;
  }

  /** One grant on the Space is what makes it restricted; no rows at all means unrestricted. */
  async function restrictSpaceTo(userId: string): Promise<void> {
    await acl.put({
      businessId: BUSINESS,
      subjectKind: "space",
      subjectId: spaceId,
      principal: { kind: "user", id: userId },
      effect: "grant",
      capability: "read",
    });
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    acl = new PgKnowledgeAclRepo(db);
    overrides = new PgKnowledgeSpaceOverrideRepo(db);
    service = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      spaces: new PgKnowledgeSpaceRepo(db),
      links: new PgKnowledgeLinksRepo(db),
      overrides,
      embeddings: lexicalOnly(),
      retrieval: new PageRetrievalService(db),
      acl,
    });
    gate = new PageReadGate(db, BUSINESS);

    insider = await addMember();
    outsider = await addMember();

    const sp = await call("create_space", { name: "layoffs" }, insider);
    spaceId = (sp.data as { id: string }).id;
    await call("write_page", { spaceId, path: "plan", content: "# Plan" }, insider);
  });

  afterEach(async () => {
    await db.close();
  });

  it("control: navigate_space works for the insider, so a later refusal is the gate talking", async () => {
    await restrictSpaceTo(insider);
    const res = await call("navigate_space", { spaceId }, insider);
    expect(res.success).toBe(true);
  });

  it("answers navigate_space on a restricted Space exactly as it answers a Space that is not there", async () => {
    await restrictSpaceTo(insider);

    const denied = await call("navigate_space", { spaceId }, outsider);
    const absent = await call("navigate_space", { spaceId: randomUUID() }, outsider);

    expect(denied.success).toBe(false);
    expect(denied).toEqual(absent);
  });

  it("answers get_space_graph on a restricted Space exactly as it answers a Space that is not there", async () => {
    await restrictSpaceTo(insider);

    const denied = await call("get_space_graph", { spaceId }, outsider);
    const absent = await call("get_space_graph", { spaceId: randomUUID() }, outsider);

    expect(denied.success).toBe(false);
    expect(denied).toEqual(absent);
  });

  it("does not leak a restricted Space's index override through navigate_space", async () => {
    await overrides.upsert({
      spaceId,
      dirPath: "",
      file: "index.md",
      content: "# Confidential index",
      updatedAt: new Date(),
    });
    await restrictSpaceTo(insider);

    const res = await call("navigate_space", { spaceId }, outsider);
    expect(JSON.stringify(res)).not.toContain("Confidential");
  });

  it("treats an id that cannot name a Space as absent, not as an internal error", async () => {
    for (const tool of ["navigate_space", "get_space_graph"]) {
      const res = await call(tool, { spaceId: "not-a-uuid" }, outsider);
      expect(res.success).toBe(false);
      const blob = JSON.stringify(res);
      expect(blob).not.toContain("invalid input syntax");
      expect(blob).not.toContain("uuid");
    }
  });
});
