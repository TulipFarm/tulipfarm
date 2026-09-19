import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  extractText,
  FILE_CONVERTER_REVISION,
  FileKnowledgeIndexRepo,
  type FileKnowledgeRequest,
  PgFileRepo,
  renderDocument,
} from "@tulipfarm/files";
import {
  KnowledgeService,
  PgKnowledgeAclRepo,
  PgKnowledgeChunkRepo,
  PgKnowledgeLinksRepo,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
  PgKnowledgeSpaceOverrideRepo,
  PgKnowledgeSpaceRepo,
} from "@tulipfarm/knowledge";
import { ambientTransactionPort, type Queryable } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noEmbeddings } from "../knowledge/test-support";
import { makeMigratedPglite } from "../test/pglite";

const businessId = DEPLOYMENT_BUSINESS_ID;
const ownerPrincipalId = "receipt-owner";

describe("durable File Knowledge refresh", () => {
  let db: PGlite;
  let files: PgFileRepo;
  let requests: FileKnowledgeIndexRepo;
  let request: FileKnowledgeRequest;

  function knowledge(tx: Queryable) {
    return new KnowledgeService({
      pages: new PgKnowledgePageRepo(tx),
      chunks: new PgKnowledgeChunkRepo(tx, ambientTransactionPort(tx)),
      revisions: new PgKnowledgeRevisionRepo(tx),
      spaces: new PgKnowledgeSpaceRepo(tx),
      links: new PgKnowledgeLinksRepo(tx),
      overrides: new PgKnowledgeSpaceOverrideRepo(tx),
      acl: new PgKnowledgeAclRepo(tx),
      embeddings: noEmbeddings(),
    });
  }

  async function enqueue() {
    const receipt = await requests.request(request, async () => {});
    return { ...request, requestId: receipt.requestId };
  }

  async function publish(job: FileKnowledgeRequest, text: string) {
    const claim = await requests.claim(job);
    if (!claim) throw new Error("request not claimable");
    const spaces = new PgKnowledgeSpaceRepo(db);
    const space = await knowledge(db).findSpaceByName("Files");
    const created = space ? null : await knowledge(db).createSpace({ name: "Files" });
    const spaceId = space?._id ?? (created?.ok ? created.space._id : null);
    if (!spaceId) throw new Error("Space not created");
    const result = await requests.publish(claim, async (tx) => {
      const page = await knowledge(tx).ingestSource({
        source: "file",
        sourceId: request.fileId,
        title: "guide.docx",
        content: text,
        readers: [{ kind: "user", id: ownerPrincipalId }],
        placement: { spaceId, path: `${request.fileId}.md` },
      });
      if (!page) throw new Error("Page not created");
      return { pageId: page._id, truncated: false };
    });
    expect(await spaces.getById(spaceId)).not.toBeNull();
    return result;
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    files = new PgFileRepo(db);
    requests = new FileKnowledgeIndexRepo(db);
    const file = await files.create({
      id: randomUUID(),
      businessId,
      ownerPrincipalId,
      filename: "guide.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      claimedMediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 1,
      blob: { key: "fixture", hash: "fixture" },
    });
    await files.setKnowledgeRequested(businessId, file.id, new Date());
    request = { businessId, fileId: file.id, versionId: file.currentVersionId, ownerPrincipalId };
  });

  afterEach(async () => {
    await db.close();
  });

  it("recovers retries of a pre-receipt queue job without adopting a newer request", async () => {
    const legacy = { ...request, legacyJobId: randomUUID() };
    const first = await requests.claim(legacy);
    if (!first) throw new Error("legacy claim missing");
    expect(first.requestId).toBe(legacy.legacyJobId);
    await requests.settle(first, "queued", "retry_pending");
    const retry = await requests.claim(legacy);
    expect(retry?.attempt).toBe(2);
    if (!retry) throw new Error("legacy retry missing");
    await requests.settle(retry, "failed", "index_failed");
    const newer = await enqueue();
    expect(newer.requestId).not.toBe(legacy.legacyJobId);
    expect(await requests.claim(legacy)).toBeNull();
    expect((await requests.current(businessId, [request.fileId])).get(request.fileId)?.status).toBe(
      "queued"
    );
  });

  it("atomically queues one current request and rolls back a rejected queue insertion", async () => {
    await expect(
      requests.request(request, async () => {
        throw new Error("queue unavailable");
      })
    ).rejects.toThrow("queue unavailable");
    expect((await requests.current(businessId, [request.fileId])).size).toBe(0);
    const send = vi.fn(async () => {});
    const first = await requests.request(request, send);
    const second = await requests.request(request, send);
    expect(first.requestId).toBe(second.requestId);
    expect(first.converterRevision).toBe(FILE_CONVERTER_REVISION);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refreshes an old same-version Page with real DOCX content after the preview ceiling", async () => {
    const initial = await publish(await enqueue(), "Earlier limited conversion.");
    const next = await enqueue();
    expect(
      (await requests.current(businessId, [request.fileId])).get(request.fileId)
    ).toMatchObject({
      status: "queued",
      indexedConverterRevision: FILE_CONVERTER_REVISION,
    });
    const before = await new PgKnowledgePageRepo(db).getBySource("file", request.fileId);
    expect(before?.content).toBe("Earlier limited conversion.");
    const document = await renderDocument({
      format: "docx",
      content: `${Array.from({ length: 405 }, (_, i) => `Line ${i}`).join("\n\n")}\n\nRenewal lasts 83 days.`,
    });
    const extracted = await extractText(document.mediaType, document.bytes);
    if (extracted.kind === "refused") throw new Error("DOCX was refused");
    const refreshed = await publish(next, extracted.text);
    expect(refreshed?.pageId).toBe(initial?.pageId);
    const page = await new PgKnowledgePageRepo(db).getBySource("file", request.fileId);
    expect(page?.content).toContain("Renewal lasts 83 days.");
    if (!page) throw new Error("Page missing");
    const chunks = new PgKnowledgeChunkRepo(db);
    expect(await chunks.searchLexical("Renewal lasts", 10, { source: "file" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pageId: page._id,
          content: expect.stringContaining("Renewal lasts 83 days."),
        }),
      ])
    );
    expect(
      await chunks.searchLexical("Earlier limited conversion", 10, { source: "file" })
    ).toHaveLength(0);
    expect((await requests.current(businessId, [request.fileId])).get(request.fileId)?.status).toBe(
      "succeeded"
    );
  });

  it("rolls back content and search replacement together when publication fails", async () => {
    const first = await publish(await enqueue(), "The previous answer is fourteen days.");
    const claim = await requests.claim(await enqueue());
    if (!claim || !first) throw new Error("request missing");
    await expect(
      requests.publish(claim, async (tx) => {
        await tx.query("UPDATE knowledge_pages SET content = 'uncommitted' WHERE id = $1", [
          first.pageId,
        ]);
        await new PgKnowledgeChunkRepo(tx, ambientTransactionPort(tx)).deleteByPage(first.pageId);
        throw new Error("index failed");
      })
    ).rejects.toThrow("index failed");
    await requests.settle(claim, "failed", "index_failed");
    expect(
      (await new PgKnowledgePageRepo(db).getBySource("file", request.fileId))?.content
    ).toContain("fourteen days");
    expect(await new PgKnowledgeChunkRepo(db).listByPageForDiff(first.pageId)).not.toHaveLength(0);
    expect(
      (await requests.current(businessId, [request.fileId])).get(request.fileId)
    ).toMatchObject({
      status: "failed",
      reason: "index_failed",
    });
  });

  it("fences superseded attempts and completed duplicate jobs", async () => {
    const job = await enqueue();
    const first = await requests.claim(job);
    const second = await requests.claim(job);
    if (!first || !second) throw new Error("claim missing");
    const staleWrite = vi.fn(async () => ({ pageId: "unused", truncated: false }));
    expect(await requests.publish(first, staleWrite)).toBeNull();
    expect(staleWrite).not.toHaveBeenCalled();
    await requests.settle(first, "failed", "index_failed");
    expect((await requests.current(businessId, [request.fileId])).get(request.fileId)?.status).toBe(
      "processing"
    );
    await requests.publish(second, async () => ({ pageId: "example", truncated: false }));
    expect(await requests.claim(job)).toBeNull();
  });

  it("does not let old request identities settle a newer refresh", async () => {
    const old = await requests.claim(await enqueue());
    if (!old) throw new Error("claim missing");
    await requests.settle(old, "refused", "unreadable");
    const next = await enqueue();
    expect(next.requestId).not.toBe(old.requestId);
    await requests.settle(old, "failed", "index_failed");
    const write = vi.fn(async () => ({ pageId: "unused", truncated: false }));
    expect(await requests.publish(old, write)).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect((await requests.current(businessId, [request.fileId])).get(request.fileId)?.status).toBe(
      "queued"
    );
    expect(await requests.claim(request)).toBeNull();
  });

  it.each(["withdraw", "archive", "replace"] as const)(
    "fences %s during conversion",
    async (action) => {
      const claim = await requests.claim(await enqueue());
      if (!claim) throw new Error("claim missing");
      if (action === "withdraw")
        await files.setKnowledgeRequested(businessId, request.fileId, null);
      if (action === "archive") await files.setArchived(businessId, request.fileId, 1, true);
      if (action === "replace") {
        await files.replaceVersion({
          id: randomUUID(),
          businessId,
          fileId: request.fileId,
          expectedRevision: 1,
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          claimedMediaType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 2,
          blob: { key: "new", hash: "new" },
          actorKind: "principal",
          actorId: ownerPrincipalId,
          reason: "replaced",
        });
      }
      const write = vi.fn(async () => ({ pageId: "unused", truncated: false }));
      expect(await requests.publish(claim, write)).toBeNull();
      expect(write).not.toHaveBeenCalled();
    }
  );
});
