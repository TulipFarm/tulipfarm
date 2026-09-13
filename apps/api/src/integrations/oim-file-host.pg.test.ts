import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  FILE_DRAFT_STATEMENTS,
  FILE_FOLDER_STATEMENTS,
  FILE_KNOWLEDGE_STATEMENTS,
  FILE_ORIGIN_STATEMENTS,
  FILE_SHARE_STATEMENTS,
  FILE_STORAGE_STATEMENTS,
  FILE_VERSION_STATEMENTS,
  type FileAssetOwnership,
  type FileOwnershipPort,
  FileService,
  PgFileRepo,
} from "@tulipfarm/files";
import type { BlobBody, BlobMetadata, BlobPort, BlobRange, BlobRef } from "@tulipfarm/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOimFileHost } from "./oim-file-host";

vi.mock("@tulipfarm/soul", () => ({}));

const BUSINESS_ID = "default";
const OWNER_ID = "user-owner";
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  )
);

class MemoryBlobPort implements BlobPort {
  private readonly blobs = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(body: BlobBody, contentType?: string): Promise<BlobRef> {
    const chunks: Uint8Array[] = [];
    if (body instanceof Uint8Array) {
      chunks.push(body);
    } else {
      for await (const chunk of body) chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const hash = createHash("sha256").update(bytes).digest("hex");
    this.blobs.set(hash, { bytes, ...(contentType === undefined ? {} : { contentType }) });
    return { key: hash, hash };
  }

  async get(ref: BlobRef, range?: BlobRange): Promise<AsyncIterable<Uint8Array>> {
    const found = this.blobs.get(ref.key);
    if (found === undefined) throw new Error("blob not found");
    const end = range?.end === undefined ? found.bytes.length : range.end + 1;
    const bytes = found.bytes.slice(range?.start ?? 0, end);
    return (async function* () {
      yield bytes;
    })();
  }

  async head(ref: BlobRef): Promise<BlobMetadata | null> {
    const found = this.blobs.get(ref.key);
    if (found === undefined) return null;
    return {
      size: found.bytes.byteLength,
      ...(found.contentType === undefined ? {} : { contentType: found.contentType }),
    };
  }

  async delete(ref: BlobRef): Promise<void> {
    this.blobs.delete(ref.key);
  }
}

class MutableFileOwnership implements FileOwnershipPort {
  private ownership: FileAssetOwnership | undefined;
  private readable = true;

  async createPersonal(businessId: string, fileId: string, principalId: string): Promise<void> {
    const now = new Date();
    this.ownership = {
      businessId,
      assetType: "file",
      assetId: fileId,
      owners: [{ kind: "principal", principalId, principalKind: "user" }],
      shares: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  async get(): Promise<FileAssetOwnership | undefined> {
    return this.ownership;
  }

  async accessFor() {
    return {
      levels: this.readable ? (["view"] as const) : [],
      canManageOwnership: false,
    };
  }

  revoke(): void {
    this.readable = false;
  }

  async consumeDestructiveApproval(): Promise<void> {}

  async teamReadableFileIds(): Promise<readonly string[]> {
    return [];
  }

  async teamGrantCounts(): Promise<Map<string, number>> {
    return new Map();
  }

  async unreadableAmong(): Promise<ReadonlySet<string>> {
    return new Set();
  }
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe("OIM File host", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it("stores a binary provider response as a real File owned by the bound caller", async () => {
    const database = await PGlite.create();
    databases.push(database);
    for (const statement of [
      ...FILE_STORAGE_STATEMENTS,
      ...FILE_ORIGIN_STATEMENTS,
      ...FILE_SHARE_STATEMENTS,
      ...FILE_KNOWLEDGE_STATEMENTS,
      ...FILE_VERSION_STATEMENTS,
      ...FILE_DRAFT_STATEMENTS,
      ...FILE_FOLDER_STATEMENTS,
    ]) {
      await database.exec(statement);
    }
    const ownership = new MutableFileOwnership();
    const service = new FileService({
      repo: new PgFileRepo(database as never),
      blobs: new MemoryBlobPort(),
      newId: randomUUID,
      rolesOf: async () => [],
      ownership,
    });
    const host = createOimFileHost({
      files: service,
      runAuthority: {
        async authority() {
          return {
            businessId: BUSINESS_ID,
            runId: "run-1",
            subject: { kind: "user", id: OWNER_ID },
          };
        },
      },
      authorityLayers: {
        async resolvePrincipalLayer(name) {
          return {
            name,
            grants: [{ action: "*", resourceType: "*", effect: "allow" }],
          };
        },
        async resolveAgentLayer() {
          return {
            name: "agent",
            grants: [{ action: "*", resourceType: "*", effect: "allow" }],
          };
        },
      },
    });

    const stored = await host.files.store({
      businessId: BUSINESS_ID,
      ownerPrincipalId: OWNER_ID,
      filename: "provider-download.png",
      claimedMediaType: "image/png",
      declaredBytes: PNG.byteLength,
      body: (async function* () {
        yield PNG;
      })(),
    });
    const content = await host.files.content({
      businessId: BUSINESS_ID,
      fileId: stored.id,
      principalId: OWNER_ID,
    });

    expect(stored).toMatchObject({
      filename: "provider-download.png",
      mediaType: "image/png",
      sizeBytes: PNG.byteLength,
    });
    expect([...(await collect(content.body))]).toEqual([...PNG]);
    ownership.revoke();
    await expect(
      host.files.content({
        businessId: BUSINESS_ID,
        fileId: stored.id,
        principalId: OWNER_ID,
      })
    ).rejects.toMatchObject({ reason: "not_found" });
    await expect(
      host.files.content({
        businessId: BUSINESS_ID,
        fileId: stored.id,
        principalId: "user-stranger",
      })
    ).rejects.toMatchObject({ reason: "not_found" });
  });
});
