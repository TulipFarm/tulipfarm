import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../../pg-migrate";
import { makePglite } from "../../test/pglite";
import { PgKnowledgeChunkRepo } from "../chunks-repo";
import { PgKnowledgePageRepo, PgKnowledgeRevisionRepo } from "../repo";
import { KnowledgeService } from "../service";
import type { EmbeddingPort } from "../types";
import { SampleConnector } from "./sample";
import { PgConnectorStateRepo } from "./state-repo";
import { GoogleDocsConnector } from "./stubs";
import { runConnectorSync, syncConnector } from "./sync";
import { type Connector, ConnectorRegistry, NotImplementedError } from "./types";

function fakeEmbeddings(): EmbeddingPort {
  return {
    isAvailable: () => true,
    embedMany: async (values) => ({ embeddings: values.map(() => [0.1, 0.1, 0.1]), dimension: 3 }),
    getActive: () => ({ provider: "fake", model: "m", dimension: 3 }),
    getDimension: () => 3,
    consumePendingReindex: () => false,
  };
}

const ONE = {
  id: "welcome",
  title: "Welcome",
  body: "intro body",
  updatedAt: "2026-06-01T00:00:00.000Z",
};
const TWO = {
  id: "runbook",
  title: "Runbook",
  body: "runbook body",
  updatedAt: "2026-06-02T00:00:00.000Z",
};

describe("connector sync (SampleConnector)", () => {
  let db: PGlite;
  let service: KnowledgeService;
  let state: PgConnectorStateRepo;
  let fixtures: string;

  async function writeFixtures(records: unknown[]): Promise<void> {
    await writeFile(fixtures, JSON.stringify(records), "utf8");
  }

  function makeRegistry(): ConnectorRegistry {
    return new ConnectorRegistry([new SampleConnector(fixtures)]);
  }

  async function enableSample(): Promise<void> {
    await state.ensure("sample");
    await state.setEnabled("sample", true);
  }

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    service = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      embeddings: fakeEmbeddings(),
    });
    state = new PgConnectorStateRepo(db);
    const dir = await mkdtemp(join(tmpdir(), "tf-connector-"));
    fixtures = join(dir, "sample.json");
    await writeFixtures([ONE, TWO]);
  });
  afterEach(async () => {
    await db.close();
  });

  it("creates pages, advances the cursor, and re-syncs idempotently", async () => {
    await enableSample();
    const deps = { registry: makeRegistry(), state, service };

    const first = await runConnectorSync(deps);
    expect(first).toEqual([{ connector: "sample", synced: 2 }]);

    const pages = await service.listPages({ limit: 10 });
    expect(pages.items).toHaveLength(2);
    expect(pages.items.map((p) => p.source)).toEqual(["resource", "resource"]);
    expect(pages.items.map((p) => p.sourceId).sort()).toEqual(["sample:runbook", "sample:welcome"]);

    // Cursor advanced to the newest record.
    expect((await state.get("sample"))?.cursor).toBe(TWO.updatedAt);
    expect((await state.get("sample"))?.lastError).toBeNull();

    // Nothing changed → second sync does no work and creates no duplicates.
    const second = await runConnectorSync(deps);
    expect(second).toEqual([{ connector: "sample", synced: 0 }]);
    expect((await service.listPages({ limit: 10 })).items).toHaveLength(2);
  });

  it("re-syncs a record whose timestamp advanced, upserting in place (no duplicate)", async () => {
    await enableSample();
    const deps = { registry: makeRegistry(), state, service };
    await runConnectorSync(deps);

    // Bump welcome past the cursor with new content.
    await writeFixtures([
      { ...ONE, body: "updated intro", updatedAt: "2026-06-03T00:00:00.000Z" },
      TWO,
    ]);
    const res = await runConnectorSync(deps);
    expect(res).toEqual([{ connector: "sample", synced: 1 }]);

    const pages = await service.listPages({ limit: 10 });
    expect(pages.items).toHaveLength(2); // upsert, not insert
    const welcome = pages.items.find((p) => p.sourceId === "sample:welcome");
    expect(welcome?.content).toBe("updated intro");
  });

  it("never overwrites a locally-authored page", async () => {
    const authored = await service.createPage({ title: "Mine", content: "hand-authored body" });
    await enableSample();
    await runConnectorSync({ registry: makeRegistry(), state, service });

    const still = await service.getPage(authored._id);
    expect(still?.source).toBe("authored");
    expect(still?.content).toBe("hand-authored body");
    expect(still?.version).toBe(authored.version); // untouched by the sync
  });

  it("isolates a failing connector: records last_error and keeps its cursor", async () => {
    await state.ensure("google-docs");
    await state.setEnabled("google-docs", true);
    const registry = new ConnectorRegistry([new GoogleDocsConnector()]);
    const result = await syncConnector(new GoogleDocsConnector(), { registry, state, service });
    expect(result.error).toContain("not implemented");
    const row = await state.get("google-docs");
    expect(row?.lastError).toContain("not implemented");
    expect(row?.cursor).toBeNull(); // cursor only advances on success
  });

  it("stub connectors throw NotImplementedError", () => {
    expect(() => new GoogleDocsConnector().authenticate()).toThrow(NotImplementedError);
  });

  it("isolates a per-record failure: syncs the good records and still advances the cursor", async () => {
    // A connector whose fetch throws for one id but succeeds for the others.
    const connector: Connector = {
      name: "flaky",
      authenticate: async () => {},
      listChanged: async () => ({ ids: ["ok-1", "bad", "ok-2"], cursor: "c2" }),
      fetch: async (id) => {
        if (id === "bad") throw new Error("boom");
        return { id, title: id, body: `body ${id}` };
      },
      mapToPage: (record) => ({
        kind: "flat",
        input: {
          source: "resource",
          sourceId: `flaky:${record.id}`,
          title: String(record.title),
          content: String(record.body),
        },
      }),
    };
    await state.ensure("flaky");
    const result = await syncConnector(connector, {
      registry: new ConnectorRegistry([connector]),
      state,
      service,
    });
    expect(result.synced).toBe(2); // both good records written
    expect(result.error).toContain("boom");
    // Cursor advances despite the bad record, so it can't wedge the connector; error is surfaced.
    const row = await state.get("flaky");
    expect(row?.cursor).toBe("c2");
    expect(row?.lastError).toContain("boom");
    expect((await service.listPages({ limit: 10 })).items).toHaveLength(2);
  });
});
