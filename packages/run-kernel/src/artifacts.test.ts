import { createHash } from "node:crypto";
import { canonicalHash } from "@tulipfarm/schema";
import {
  type BlobBody,
  type BlobMetadata,
  type BlobPort,
  type BlobRef,
  collectBlobBytes,
  MemoryArtifactStore,
  type PersistedArtifact,
} from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactAccessError,
  ArtifactService,
  type ArtifactStorePort,
  type PublishArtifactInput,
} from "./artifacts";
import { TypedOutputValidator } from "./outputs";

const CREATED_AT = "2026-07-24T10:00:00.000Z";
const NOW = new Date("2026-07-24T10:05:00.000Z");
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const SCHEMA_REF = "classify/output/v1";

const CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label"],
  properties: { label: { type: "string" }, note: { type: "string" } },
};

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

/** In-memory `BlobPort` whose bytes can be corrupted to simulate an untrusted blob store. */
class MemoryBlobStore implements BlobPort {
  private readonly bytes = new Map<string, Uint8Array>();

  async put(body: BlobBody): Promise<BlobRef> {
    const bytes = body instanceof Uint8Array ? body : await collectBlobBytes(body);
    const hash = createHash("sha256").update(bytes).digest("hex");
    this.bytes.set(hash, bytes);
    return { key: hash, hash };
  }

  async get(ref: BlobRef): Promise<AsyncIterable<Uint8Array>> {
    const stored = this.bytes.get(ref.key);
    if (!stored) throw new Error("blob_missing");
    return oneChunk(stored);
  }

  async head(ref: BlobRef): Promise<BlobMetadata | null> {
    const stored = this.bytes.get(ref.key);
    return stored === undefined ? null : { size: stored.byteLength };
  }

  async delete(ref: BlobRef): Promise<void> {
    this.bytes.delete(ref.key);
  }

  corrupt(key: string, replacement: string): void {
    this.bytes.set(key, new TextEncoder().encode(replacement));
  }
}

/** Wraps a store so it serves an altered row, simulating tampering under the service. */
function tamperedStore(
  store: MemoryArtifactStore,
  artifactId: string,
  overrides: Partial<PersistedArtifact>
): ArtifactStorePort {
  return {
    put: (input) => store.put(input),
    appendLineage: (input) => store.appendLineage(input),
    find: async (businessId, id) => {
      const found = await store.find(businessId, id);
      if (!found || id !== artifactId) return found;
      return { ...found, ...overrides };
    },
  };
}

function publishInput(overrides: Partial<PublishArtifactInput> = {}): PublishArtifactInput {
  return {
    id: "artifact-1",
    businessId: "business-1",
    schemaRef: SCHEMA_REF,
    value: { label: "billing" },
    storage: "inline",
    classification: ["internal"],
    acl: { readers: ["agent:agent-1"] },
    retention: { policy: "standard", expiresAt: null },
    redaction: { redactedPaths: [] },
    producer: { runId: RUN_ID, stateKey: "classify", attempt: 1 },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function readRequest(overrides: Record<string, unknown> = {}) {
  return {
    businessId: "business-1",
    artifactId: "artifact-1",
    reader: "agent:agent-1",
    allowedClassifications: ["internal"],
    now: NOW,
    ...overrides,
  };
}

describe("ArtifactService", () => {
  let store: MemoryArtifactStore;
  let blobs: MemoryBlobStore;
  let service: ArtifactService;

  function validator(): TypedOutputValidator {
    return new TypedOutputValidator([{ ref: SCHEMA_REF, schema: CLASSIFY_SCHEMA }]);
  }

  beforeEach(() => {
    store = new MemoryArtifactStore();
    blobs = new MemoryBlobStore();
    service = new ArtifactService(store, validator(), blobs);
  });

  it("stores validated inline output and returns it to an authorized reader", async () => {
    const published = await service.publish(publishInput());

    expect(published.contentHash).toBe(canonicalHash({ label: "billing" }));
    await expect(service.read(readRequest())).resolves.toEqual({
      schemaRef: SCHEMA_REF,
      content: { label: "billing" },
      contentHash: canonicalHash({ label: "billing" }),
    });
  });

  it("never stores schema-invalid output", async () => {
    await expect(service.publish(publishInput({ value: { label: 7 } }))).rejects.toThrow();

    expect(await store.find("business-1", "artifact-1")).toBeNull();
  });

  it("records declared lineage edges for derived output", async () => {
    await service.publish(publishInput());
    await service.publish(
      publishInput({ id: "artifact-2", value: { label: "support" }, derivedFrom: ["artifact-1"] })
    );

    expect(await store.listLineage("business-1", "artifact-2")).toEqual([
      {
        businessId: "business-1",
        artifactId: "artifact-2",
        sourceArtifactId: "artifact-1",
        relation: "derived_from",
        createdAt: CREATED_AT,
      },
    ]);
  });

  it("is idempotent when the same Artifact is republished after a crash", async () => {
    await service.publish(publishInput());
    const replay = await service.publish(publishInput());

    expect(replay.outcome).toBe("duplicate");
  });

  it("refuses to publish content that still holds a path declared redacted", async () => {
    await expect(
      service.publish(
        publishInput({
          value: { label: "billing", note: "customer ssn" },
          redaction: { redactedPaths: ["/note"] },
        })
      )
    ).rejects.toMatchObject({ code: "artifact_redaction_violation" });
    expect(await store.find("business-1", "artifact-1")).toBeNull();
  });

  describe("denials", () => {
    beforeEach(async () => {
      await service.publish(publishInput());
    });

    it("denies a principal that is not in the ACL", async () => {
      await expect(service.read(readRequest({ reader: "agent:agent-2" }))).rejects.toMatchObject({
        code: "artifact_unauthorized",
      });
    });

    it("denies by default when the ACL grants nobody", async () => {
      await service.publish(publishInput({ id: "artifact-open", acl: { readers: [] } }));

      await expect(
        service.read(readRequest({ artifactId: "artifact-open" }))
      ).rejects.toMatchObject({ code: "artifact_unauthorized" });
    });

    it("denies a reader whose context does not allow the Artifact classification", async () => {
      await expect(
        service.read(readRequest({ allowedClassifications: ["public"] }))
      ).rejects.toMatchObject({ code: "artifact_classification_denied" });
    });

    it("denies a read of another business", async () => {
      await expect(service.read(readRequest({ businessId: "business-2" }))).rejects.toMatchObject({
        code: "artifact_not_found",
      });
    });

    it("denies a foreign Artifact passed directly to the open boundary", async () => {
      const foreign = await store.find("business-1", "artifact-1");
      if (!foreign) throw new Error("expected published Artifact");

      await expect(
        service.open(foreign, readRequest({ businessId: "business-2" }))
      ).rejects.toMatchObject({ code: "artifact_not_found" });
    });

    it("denies a read past the retention expiry", async () => {
      await service.publish(
        publishInput({
          id: "artifact-expiring",
          retention: { policy: "ephemeral", expiresAt: "2026-07-24T10:01:00.000Z" },
        })
      );

      await expect(
        service.read(readRequest({ artifactId: "artifact-expiring" }))
      ).rejects.toMatchObject({ code: "artifact_expired" });
    });

    it("denies tampered stored content instead of returning it", async () => {
      const tampering = new ArtifactService(
        tamperedStore(store, "artifact-1", { content: { label: "support" } }),
        validator(),
        blobs
      );

      await expect(tampering.read(readRequest())).rejects.toMatchObject({
        code: "artifact_tampered",
      });
    });

    it("denies stored content that no longer satisfies its schema", async () => {
      const content = { label: "billing", extra: true };
      const tampering = new ArtifactService(
        tamperedStore(store, "artifact-1", { content, contentHash: canonicalHash(content) }),
        validator(),
        blobs
      );

      await expect(tampering.read(readRequest())).rejects.toMatchObject({
        code: "artifact_schema_invalid",
      });
    });

    it("reports a typed error rather than guessing when an Artifact is unknown", async () => {
      await expect(service.read(readRequest({ artifactId: "nope" }))).rejects.toBeInstanceOf(
        ArtifactAccessError
      );
    });
  });

  describe("blob-backed output", () => {
    it("round-trips a blob-backed Artifact through the blob port", async () => {
      const published = await service.publish(
        publishInput({ id: "artifact-blob", storage: "blob", value: { label: "support" } })
      );

      expect(published.blob).not.toBeNull();
      await expect(service.read(readRequest({ artifactId: "artifact-blob" }))).resolves.toEqual({
        schemaRef: SCHEMA_REF,
        content: { label: "support" },
        contentHash: canonicalHash({ label: "support" }),
      });
    });

    it("denies a blob whose bytes were tampered with", async () => {
      const published = await service.publish(
        publishInput({ id: "artifact-blob", storage: "blob", value: { label: "support" } })
      );
      if (!published.blob) throw new Error("expected a blob reference");
      blobs.corrupt(published.blob.key, '{"label":"billing"}');

      await expect(
        service.read(readRequest({ artifactId: "artifact-blob" }))
      ).rejects.toMatchObject({ code: "artifact_tampered" });
    });

    it("fails closed when no blob port is configured", async () => {
      const blindService = new ArtifactService(store, validator());

      await expect(
        blindService.publish(publishInput({ id: "artifact-blob", storage: "blob" }))
      ).rejects.toMatchObject({ code: "artifact_blob_unavailable" });
    });
  });

  describe("file output", () => {
    it("publishes and opens immutable raw file bytes", async () => {
      const bytes = new TextEncoder().encode("report contents");
      const published = await service.publishFile({
        id: "artifact-file",
        businessId: "business-1",
        bytes,
        mediaType: "text/plain",
        fileName: "report.txt",
        classification: ["internal"],
        acl: { readers: ["agent:agent-1"] },
        retention: { policy: "standard", expiresAt: null },
        redaction: { redactedPaths: [] },
        producer: { runId: RUN_ID, stateKey: "classify", attempt: 1 },
        createdAt: CREATED_AT,
      });

      expect(published.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
      await expect(service.openFile(readRequest({ artifactId: "artifact-file" }))).resolves.toEqual(
        {
          mediaType: "text/plain",
          fileName: "report.txt",
          bytes,
          contentHash: published.contentHash,
        }
      );
    });

    it("denies tampered raw file bytes", async () => {
      const published = await service.publishFile({
        id: "artifact-file",
        businessId: "business-1",
        bytes: new TextEncoder().encode("original"),
        mediaType: "text/plain",
        fileName: "report.txt",
        classification: ["internal"],
        acl: { readers: ["agent:agent-1"] },
        retention: { policy: "standard", expiresAt: null },
        redaction: { redactedPaths: [] },
        producer: { runId: RUN_ID, stateKey: "classify", attempt: 1 },
        createdAt: CREATED_AT,
      });
      blobs.corrupt(published.blob.key, "tampered");

      await expect(
        service.openFile(readRequest({ artifactId: "artifact-file" }))
      ).rejects.toMatchObject({ code: "artifact_tampered" });
    });
  });
});
