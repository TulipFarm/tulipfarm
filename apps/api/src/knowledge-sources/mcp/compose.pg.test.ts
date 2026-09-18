import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  type EmbeddingPort,
  GITHUB_KNOWLEDGE_SERVER_REVISION,
  type McpKnowledgeBinding,
  type McpKnowledgeReadPort,
  type PageReadAuthorizer,
  PgKnowledgePageRepo,
} from "@tulipfarm/knowledge";
import { type Queryable, RunStore, type TransactionPort } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../../test/pglite";
import { composeMcpKnowledge, type McpKnowledgeAccountHost } from "./compose";
import { wrapMcpKnowledgePageReadGate } from "./page-gate";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const binding: McpKnowledgeBinding = {
  businessId: BUSINESS,
  integrationId: "github",
  accountId: "account",
  accountRevision: 1,
  configurationRevision: "reviewed-config",
  ownerUserId: "owner",
  externalAccountId: "42",
};
const file = { owner: "example", repo: "docs", path: "guide.md", ref: "refs/heads/main" };
const embeddings: EmbeddingPort = {
  isAvailable: () => false,
  getActive: () => null,
  getDimension: () => null,
  pendingReindex: () => false,
  clearPendingReindex: () => {},
  embedMany: async () => {
    throw new Error("No embedding provider");
  },
};

class AccountHost implements McpKnowledgeAccountHost {
  active = true;
  readable = true;
  calls = 0;
  async captureIdentity() {
    return "42";
  }
  async bindingFor(input: { integrationKey: string; accountId: string; readerUserId: string }) {
    return this.active &&
      input.integrationKey === binding.integrationId &&
      input.accountId === binding.accountId &&
      input.readerUserId === binding.ownerUserId
      ? binding
      : undefined;
  }
  async open<T>(
    input: {
      binding: McpKnowledgeBinding;
      readerUserId: string;
      assertCurrent: () => Promise<void>;
    },
    callback: (read: McpKnowledgeReadPort) => Promise<T>
  ): Promise<T> {
    await input.assertCurrent();
    return callback({
      binding,
      readerUserId: input.readerUserId,
      server: { distribution: "github-official-local", revision: GITHUB_KNOWLEDGE_SERVER_REVISION },
      callTool: async (request) => {
        await input.assertCurrent();
        this.calls++;
        if (!this.readable) return { isError: true, content: [] };
        return request.name === "get_me"
          ? { content: [{ type: "text", text: '{"id":42}' }] }
          : {
              content: [
                {
                  type: "text",
                  text: `successfully downloaded text file (SHA: ${"a".repeat(40)})`,
                },
                {
                  type: "resource",
                  resource: {
                    uri: `repo://example/docs/sha/${"b".repeat(40)}/contents/guide.md`,
                    mimeType: "text/plain",
                    text: "Private release checklist",
                  },
                },
              ],
            };
      },
    });
  }
}

describe("durable MCP Knowledge composition", () => {
  let db: PGlite;
  let accounts: AccountHost;
  let feature: ReturnType<typeof composeMcpKnowledge>;
  beforeEach(async () => {
    db = await makeMigratedPglite();
    accounts = new AccountHost();
    const transactions: TransactionPort = {
      withTransaction: (work) => db.transaction((tx) => work(tx as Queryable)),
    };
    feature = composeMcpKnowledge({ db, transactions, businessId: BUSINESS, accounts, embeddings });
  });
  afterEach(async () => db.close());

  async function cycle() {
    const cleaned = await feature.reconcile();
    const claim = await feature.store.claimDue(BUSINESS, randomUUID(), new Date());
    if (!claim) return { worked: false, cleaned };
    const checkpoint = await feature.batch({
      accountId: claim.selection.binding.accountId,
      selectionId: claim.selection.id,
      selectionRevision: claim.selection.revision,
      leaseId: claim.leaseId,
    });
    const now = new Date();
    await feature.store.finish(
      claim,
      now,
      new Date(now.getTime() + 900_000),
      checkpoint.failed ? "source_unavailable" : null,
      checkpoint.complete
    );
    return { worked: true, cleaned };
  }

  async function syncPage() {
    await feature.put("github", "account", "owner", { enabled: true, files: [file] });
    expect(await cycle()).toEqual({ worked: true, cleaned: 0 });
    const result = await db.query<{ id: string }>(
      "SELECT id FROM knowledge_pages WHERE source='mcp'"
    );
    const pageId = result.rows[0]?.id;
    if (!pageId) throw new Error("No published Page");
    return pageId;
  }

  it("publishes a placed source-backed Page and normal indexes, never an authored blanket grant", async () => {
    const pageId = await syncPage();
    const page = await new PgKnowledgePageRepo(db).getById(pageId);
    expect(page).toMatchObject({
      source: "mcp",
      plainText: "Private release checklist",
      active: true,
    });

    expect(page?.spaceId).toBeTruthy();
    expect(page?.path).toBeTruthy();
    expect(
      (await db.query("SELECT * FROM knowledge_chunks WHERE page_id=$1", [pageId])).rows
    ).toHaveLength(1);
    expect((await db.query("SELECT * FROM knowledge_source_chunks")).rows).toHaveLength(1);
    expect(
      (await db.query("SELECT * FROM knowledge_acl_entries WHERE subject_id=$1", [pageId])).rows
    ).toHaveLength(0);
    expect((await feature.status("github", "account", "owner")).selection?.progress).toMatchObject({
      complete: true,
      synced: 1,
    });
  });

  it("rolls Page publication and its chunks back when the later source index write fails", async () => {
    await db.exec(`
      CREATE FUNCTION reject_mcp_source_chunk() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected source index failure';
      END;
      $$;
      CREATE TRIGGER reject_mcp_source_chunk BEFORE INSERT ON knowledge_source_chunks
      FOR EACH ROW EXECUTE FUNCTION reject_mcp_source_chunk();
    `);
    await feature.put("github", "account", "owner", { enabled: true, files: [file] });
    await expect(cycle()).rejects.toThrow("injected source index failure");
    const { rows } = await db.query<{ active: boolean; content: string }>(
      "SELECT active,content FROM knowledge_pages WHERE source='mcp'"
    );
    expect(rows).toEqual([{ active: false, content: "" }]);
    expect((await db.query("SELECT * FROM knowledge_chunks")).rows).toHaveLength(0);
    expect((await db.query("SELECT * FROM knowledge_source_chunks")).rows).toHaveLength(0);
    expect(
      (
        await db.query<{ cleanup_pending: boolean }>(
          "SELECT cleanup_pending FROM mcp_knowledge_source_links"
        )
      ).rows
    ).toEqual([{ cleanup_pending: true }]);
  });

  it("rebuilds source-use authority from the exact persisted selection and actual owner", async () => {
    await syncPage();
    const selection = (await feature.store.get(BUSINESS, "account"))?.selection;
    if (!selection) throw new Error("Missing selection");
    expect(await feature.contextFor("owner", selection.id)).toMatchObject({
      kind: "knowledge_sync",
      syncId: selection.id,
      ownerPrincipalId: "owner",
      visibility: "owner",
      accountId: "account",
      accountRevision: 1,
      definitionDigest: binding.configurationRevision,
    });
    await expect(feature.contextFor("other-user", selection.id)).rejects.toThrow(
      "identity_mismatch"
    );
    const caller = { principal: { kind: "user", id: "owner" }, knowledgeSyncId: selection.id };
    const scope = {
      businessId: BUSINESS,
      integrationKey: "github",
      definitionDigest: binding.configurationRevision,
    };
    expect(await feature.context(caller, scope, { kind: "tool", name: "get_me" })).toMatchObject({
      kind: "knowledge_sync",
      ownerPrincipalId: "owner",
      syncId: selection.id,
    });
    await expect(
      feature.context(
        caller,
        { ...scope, definitionDigest: "changed" },
        { kind: "tool", name: "get_me" }
      )
    ).rejects.toThrow("selection_changed");
    await expect(
      feature.context(caller, scope, { kind: "tool", name: "create_issue" })
    ).rejects.toThrow("identity_mismatch");
    await feature.change("github", "account", "owner", 1, true);
    await expect(feature.contextFor("owner", selection.id)).rejects.toThrow(
      "knowledge_selection_changed"
    );
  });

  it("derives worker reader identity from the running Run rather than a requested owner", async () => {
    const pageId = await syncPage();
    const runs = new RunStore({
      withTransaction: (work) => db.transaction((tx) => work(tx as Queryable)),
    });
    const runId = randomUUID();
    await runs.start({
      id: runId,
      businessId: BUSINESS,
      source: "routine",
      bundle: { digest: "bundle", routineId: "routine", routineVersion: "1" },
      identity: {
        initiator: { kind: "user", id: "owner" },
        effectiveSubject: { kind: "user", id: "other-user" },
        guardrailContextRef: "guardrails",
      },
      createdAt: new Date().toISOString(),
      states: [],
    });
    await db.query(
      "UPDATE runs SET status='running',lease_owner='worker',lease_expires_at=now()+interval '1 minute' WHERE id=$1",
      [runId]
    );
    const calls = accounts.calls;
    expect(await feature.canReadPageForRun(runId, "owner", pageId)).toBe(false);
    expect(await feature.canReadPageForRun(runId, "other-user", pageId)).toBe(false);
    expect(accounts.calls).toBe(calls);
  });

  it("does a new viewer permission read every time, never borrows the owner's identity", async () => {
    const pageId = await syncPage();
    const calls = accounts.calls;
    expect(await feature.canReadPage("other-user", pageId)).toBe(false);
    expect(accounts.calls).toBe(calls);
    expect(await feature.canReadPage("owner", pageId)).toBe(true);
    expect(await feature.canReadPage("owner", pageId)).toBe(true);
    expect(accounts.calls).toBe(calls + 4);
    accounts.readable = false;
    expect(await feature.canReadPage("owner", pageId)).toBe(false);
  });

  it("makes all Page gate entry points honor source reads and refuses edits through authored grants", async () => {
    const pageId = await syncPage();
    const authored: PageReadAuthorizer = {
      canRead: async () => true,
      readablePageIds: async (_, pageIds) => ({ allowed: pageIds, excluded: 0 }),
      canReadSpace: async () => true,
      readableSpaceIds: async (_, spaceIds) => spaceIds,
      canEdit: async () => true,
      assertDeleteApproved: async () => {},
    };
    const gate = wrapMcpKnowledgePageReadGate(authored, feature);
    expect(await gate.canRead("owner", pageId)).toBe(true);
    expect(await gate.readablePageIds("other-user", [pageId])).toEqual({
      allowed: [],
      excluded: 1,
    });
    expect(await gate.canEdit?.("owner", "page", pageId)).toBe(false);
    await expect(gate.assertDeleteApproved?.("page", pageId, undefined)).rejects.toThrow(
      "mcp_knowledge_read_only"
    );
    const page = await new PgKnowledgePageRepo(db).getById(pageId);
    if (!page?.spaceId) throw new Error("Page is unplaced");
    expect(await gate.canEdit?.("owner", "space", page.spaceId)).toBe(false);
  });

  it("hides a disconnected account immediately and purges the copy without deleting independent notes", async () => {
    const pageId = await syncPage();
    const pages = new PgKnowledgePageRepo(db);
    const noteId = randomUUID();
    await pages.insert({
      _id: noteId,
      title: "Independent note",
      content: "User's own note",
      plainText: "User's own note",
      source: "authored",
      sourceId: noteId,
      domain: null,
      tags: [],
      active: true,
      alwaysLoadForAgents: false,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    accounts.active = false;
    expect(await feature.canReadPage("owner", pageId)).toBe(false);
    expect(await cycle()).toEqual({ worked: false, cleaned: 1 });
    expect(await pages.getById(pageId)).toBeNull();
    expect((await pages.getById(noteId))?.content).toBe("User's own note");
    expect((await db.query("SELECT * FROM knowledge_source_chunks")).rows).toHaveLength(0);
    expect((await db.query("SELECT status FROM knowledge_source_records")).rows).toEqual([
      { status: "deleted" },
    ]);
  });

  it("marks a failed early refresh stale while requiring a successful live read of the retained copy", async () => {
    const pageId = await syncPage();
    await feature.change("github", "account", "owner", 1, false);
    accounts.readable = false;
    await cycle();
    expect(await feature.canReadPage("owner", pageId)).toBe(false);
    accounts.readable = true;
    expect(await feature.pageMetadata("owner", pageId)).toMatchObject({
      stale: true,
      readOnly: true,
    });
  });
});
