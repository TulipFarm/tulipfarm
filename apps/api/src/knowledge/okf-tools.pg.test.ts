import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import { PgKnowledgeLinksRepo } from "./links-repo";
import { PgKnowledgePageRepo, PgKnowledgeRevisionRepo } from "./repo";
import { PageRetrievalService } from "./retrieval-service";
import { KnowledgeService } from "./service";
import { PgKnowledgeSpaceOverrideRepo } from "./space-overrides-repo";
import { PgKnowledgeSpaceRepo } from "./spaces-repo";
import { KNOWLEDGE_TOOLS, type KnowledgeTool, type KnowledgeToolContext } from "./tools";
import type { EmbeddingPort } from "./types";

function lexicalOnly(): EmbeddingPort {
  return {
    isAvailable: () => false,
    embedMany: async (values) => ({ embeddings: values.map(() => [0, 0, 0]), dimension: 3 }),
    getActive: () => null,
    getDimension: () => null,
    consumePendingReindex: () => false,
  };
}

const byName = Object.fromEntries(KNOWLEDGE_TOOLS.map((t) => [t.name, t])) as Record<
  string,
  KnowledgeTool
>;

const PAGE = `---\ntype: Playbook\ntitle: Incident\n---\n\nTriage steps for the orders pipeline.`;

describe("OKF agent tools", () => {
  let db: PGlite;
  let ctx: KnowledgeToolContext;
  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    const service = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      spaces: new PgKnowledgeSpaceRepo(db),
      links: new PgKnowledgeLinksRepo(db),
      overrides: new PgKnowledgeSpaceOverrideRepo(db),
      embeddings: lexicalOnly(),
      retrieval: new PageRetrievalService(db),
    });
    ctx = { userId: "u", service };
  });
  afterEach(async () => {
    await db.close();
  });

  it("registers the four OKF tools", () => {
    for (const name of ["create_space", "list_spaces", "write_page", "navigate_space"]) {
      expect(byName[name]).toBeDefined();
    }
  });

  it("create_space -> write_page -> navigate_space happy path", async () => {
    const cb = await byName.create_space.handler({ name: "ops" }, ctx);
    expect(cb.success).toBe(true);
    const spaceId = (cb as { success: true; data: { id: string } }).data.id;

    const wc = await byName.write_page.handler(
      { spaceId, path: "playbooks/incident", content: PAGE },
      ctx
    );
    expect(wc.success).toBe(true);

    const nav = await byName.navigate_space.handler({ spaceId }, ctx);
    expect(nav.success).toBe(true);
    expect((nav as { success: true; data: { listing: string } }).data.listing).toContain(
      "[playbooks](playbooks/)"
    );

    const lb = await byName.list_spaces.handler({}, ctx);
    expect((lb as { success: true; data: { spaces: unknown[] } }).data.spaces).toHaveLength(1);
  });

  it("write_page rejects missing args and an unknown space", async () => {
    const missing = await byName.write_page.handler({ spaceId: "x" }, ctx);
    expect(missing.success).toBe(false);

    const noSpace = await byName.write_page.handler(
      { spaceId: randomUUID(), path: "p", content: PAGE },
      ctx
    );
    expect(noSpace).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("navigate_space 404s an unknown space", async () => {
    const nav = await byName.navigate_space.handler({ spaceId: randomUUID() }, ctx);
    expect(nav).toMatchObject({ success: false, error: { code: "not_found" } });
  });
});
