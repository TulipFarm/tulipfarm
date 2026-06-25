import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeBundleOverrideRepo } from "./bundle-overrides-repo";
import { PgKnowledgeBundleRepo } from "./bundles-repo";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import { PgKnowledgeLinksRepo } from "./links-repo";
import {
  PgKnowledgeCollectionRepo,
  PgKnowledgeDocumentRepo,
  PgKnowledgeRevisionRepo,
} from "./repo";
import { KnowledgeService } from "./service";
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

const CONCEPT = `---\ntype: Playbook\ntitle: Incident\n---\n\nTriage steps for the orders pipeline.`;

describe("OKF agent tools", () => {
  let db: PGlite;
  let ctx: KnowledgeToolContext;
  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    const service = new KnowledgeService({
      documents: new PgKnowledgeDocumentRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      collections: new PgKnowledgeCollectionRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      bundles: new PgKnowledgeBundleRepo(db),
      links: new PgKnowledgeLinksRepo(db),
      overrides: new PgKnowledgeBundleOverrideRepo(db),
      embeddings: lexicalOnly(),
    });
    ctx = { userId: "u", service };
  });
  afterEach(async () => {
    await db.close();
  });

  it("registers the four OKF tools", () => {
    for (const name of ["create_bundle", "list_bundles", "write_concept", "navigate_bundle"]) {
      expect(byName[name]).toBeDefined();
    }
  });

  it("create_bundle -> write_concept -> navigate_bundle happy path", async () => {
    const cb = await byName.create_bundle.handler({ name: "ops" }, ctx);
    expect(cb.success).toBe(true);
    const bundleId = (cb as { success: true; data: { id: string } }).data.id;

    const wc = await byName.write_concept.handler(
      { bundleId, path: "playbooks/incident", content: CONCEPT },
      ctx
    );
    expect(wc.success).toBe(true);

    const nav = await byName.navigate_bundle.handler({ bundleId }, ctx);
    expect(nav.success).toBe(true);
    expect((nav as { success: true; data: { listing: string } }).data.listing).toContain(
      "[playbooks](playbooks/)"
    );

    const lb = await byName.list_bundles.handler({}, ctx);
    expect((lb as { success: true; data: { bundles: unknown[] } }).data.bundles).toHaveLength(1);
  });

  it("write_concept rejects missing args and an unknown bundle", async () => {
    const missing = await byName.write_concept.handler({ bundleId: "x" }, ctx);
    expect(missing.success).toBe(false);

    const noBundle = await byName.write_concept.handler(
      { bundleId: randomUUID(), path: "p", content: CONCEPT },
      ctx
    );
    expect(noBundle).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("navigate_bundle 404s an unknown bundle", async () => {
    const nav = await byName.navigate_bundle.handler({ bundleId: randomUUID() }, ctx);
    expect(nav).toMatchObject({ success: false, error: { code: "not_found" } });
  });
});
