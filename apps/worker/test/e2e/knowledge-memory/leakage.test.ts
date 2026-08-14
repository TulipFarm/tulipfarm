/** Cross-package proof: emissions keep ACL shape and revoked evidence cannot reach Context. */

import type {
  KnowledgeChunkEmission,
  KnowledgeEmissionSink,
  KnowledgeSourceEmission,
} from "@tulipfarm/integrations";
import type {
  KnowledgeIndexEntry,
  KnowledgePrincipalRef,
  KnowledgeSourceRecord,
} from "@tulipfarm/knowledge";
import {
  decideSourceAccess,
  InMemoryInvalidationQueue,
  InMemoryKnowledgeIndex,
  InMemoryKnowledgeSourceStore,
  retrieve,
  revokeSource,
} from "@tulipfarm/knowledge";
import type { MemoryDeps, MemoryEvidenceAuthorizationPort } from "@tulipfarm/memory";
import {
  InMemoryMemoryStore,
  InMemoryPendingMemoryStore,
  recallMemory,
  rememberMemory,
} from "@tulipfarm/memory";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const now = () => NOW;
const SECRET_TEXT = "jane doe base salary 210000";

const emission: KnowledgeSourceEmission = {
  sourceId: "google-drive:salaries",
  businessId: "biz-1",
  integrationId: "int-drive",
  provider: "google-drive",
  externalId: "salaries",
  externalTenantId: "tenant-1",
  ownerExternalId: "hr@example.com",
  revision: "7",
  classification: ["restricted"],
  status: "active",
  verification: "verified",
  accessControl: { mode: "snapshot", aclRevision: "acl-1", maximumAgeSeconds: 3600 },
  acl: {
    aclRevision: "acl-1",
    capturedAt: NOW.toISOString(),
    principals: [{ kind: "user", id: "user-hr" }],
  },
  provenance: { capturedAt: NOW.toISOString(), contentHash: "a".repeat(64) },
  lastSyncedAt: NOW.toISOString(),
};

const chunkEmission: KnowledgeChunkEmission = {
  businessId: "biz-1",
  sourceId: "google-drive:salaries",
  chunkId: "google-drive:salaries#0",
  revision: "7",
  classification: ["restricted"],
  digest: "b".repeat(64),
  text: SECRET_TEXT,
};

/** Composition seam: emissions store as Knowledge records without translation. */
class KnowledgeSink implements KnowledgeEmissionSink {
  constructor(
    private readonly sources: InMemoryKnowledgeSourceStore,
    private readonly index: InMemoryKnowledgeIndex
  ) {}

  async emitSource(source: KnowledgeSourceEmission): Promise<void> {
    const record: KnowledgeSourceRecord = source;
    await this.sources.put(record);
  }

  async emitChunk(chunk: KnowledgeChunkEmission): Promise<void> {
    const entry: KnowledgeIndexEntry = chunk;
    await this.index.upsert(entry);
  }

  async removeSourceContent(businessId: string, sourceId: string): Promise<void> {
    await this.index.removeSource(businessId, sourceId);
  }

  async removeChunk(): Promise<void> {
    // The in-memory index removes whole sources only; message-granular removal is exercised in
    // `@tulipfarm/integrations`.
  }
}

function wire() {
  const sources = new InMemoryKnowledgeSourceStore();
  const index = new InMemoryKnowledgeIndex();
  const sink = new KnowledgeSink(sources, index);

  /** Live Knowledge reauthorization on every Memory recall; no cached decisions. */
  const evidence: MemoryEvidenceAuthorizationPort = {
    async authorize({ businessId, principalId, sourceId, revision }) {
      const source = await sources.get(businessId, sourceId);
      if (source === undefined) return undefined;
      const principals: readonly KnowledgePrincipalRef[] = [{ kind: "user", id: principalId }];
      const decision = await decideSourceAccess(source, { businessId, principals }, {}, now());
      if (!decision.allowed) return false;
      return revision === undefined || revision === source.revision;
    },
  };

  const memory: MemoryDeps = {
    store: new InMemoryMemoryStore(),
    pending: new InMemoryPendingMemoryStore(),
    evidence,
    settings: {
      scopes: ["user_private"],
      inferredDurableMemory: { enabled: true, confirmationRequired: true },
    },
    now,
    newId: () => "mem-1",
  };

  return { sources, index, sink, memory };
}

async function ingest(sink: KnowledgeEmissionSink): Promise<void> {
  await sink.emitSource(emission);
  await sink.emitChunk(chunkEmission);
}

function ask(deps: Parameters<typeof retrieve>[0], principalId: string) {
  return retrieve(deps, {
    businessId: "biz-1",
    principalId,
    principals: [{ kind: "user", id: principalId }],
    query: "salary",
    limit: 10,
    guardrailEpoch: "g1",
    contextEpoch: "c1",
    correlationId: `corr-${principalId}`,
  });
}

describe("integration emission conforms to the Knowledge store contract", () => {
  it("stores an emitted source and chunk without coercion, preserving the ACL", async () => {
    const { sources, index, sink } = wire();

    await ingest(sink);

    const stored = await sources.get("biz-1", "google-drive:salaries");
    expect(stored).toEqual(emission);
    expect(stored?.acl?.principals).toEqual([{ kind: "user", id: "user-hr" }]);
    expect(
      await index.search({
        businessId: "biz-1",
        query: "salary",
        limit: 10,
        allowedSourceIds: new Set(["google-drive:salaries"]),
      })
    ).toHaveLength(1);
  });

  it("emits an unreadable-permission source as unverifiable, which denies on read", async () => {
    const { sources, index, sink } = wire();
    await sink.emitSource({ ...emission, verification: "unverifiable", acl: undefined });
    await sink.emitChunk(chunkEmission);

    const result = await ask({ sources, index, now }, "user-hr");

    expect(result.candidates).toEqual([]);
    expect(result.exclusions).toEqual([{ reason: "source_unverifiable", count: 1 }]);
  });
});

describe("ingest → retrieve → remember → recall", () => {
  it("keeps the source's text out of an unauthorized reader's Context", async () => {
    const { sources, index, sink } = wire();
    await ingest(sink);

    const intruder = await ask({ sources, index, now }, "user-eng");

    expect(intruder.candidates).toEqual([]);
    // The model fake sees only retrieval output.
    const context = intruder.candidates.map((candidate) => candidate.snippet).join("\n");
    expect(context).not.toContain("210000");
    expect(JSON.stringify(intruder)).not.toContain("210000");
  });

  it("stops recalling a memory once its supporting source is revoked in Knowledge", async () => {
    const { sources, index, sink, memory } = wire();
    await ingest(sink);

    const authorized = await ask({ sources, index, now }, "user-hr");
    expect(authorized.candidates).toHaveLength(1);
    const citation = authorized.candidates[0]?.citation;
    if (citation === undefined) throw new Error("expected a citation");

    const scopeRequest = { businessId: "biz-1", principalId: "user-hr" };
    const saved = await rememberMemory(
      memory,
      {
        target: { scope: "user_private", businessId: "biz-1", subjectPrincipalId: "user-hr" },
        subject: "compensation",
        statement: "the salary band was confirmed",
        confidence: 1,
        provenance: {
          origin: "explicit",
          authorPrincipalId: "user-hr",
          evidence: [
            {
              kind: "knowledge_source",
              ref: "google-drive:salaries#0",
              sourceId: citation.sourceId,
              revision: citation.revision,
            },
          ],
        },
      },
      scopeRequest
    );
    expect(saved.outcome).toBe("saved");
    expect((await recallMemory(memory, scopeRequest)).assertions).toHaveLength(1);

    await revokeSource(
      { sources, queue: new InMemoryInvalidationQueue(), now, newId: () => "job-1" },
      { businessId: "biz-1", sourceId: "google-drive:salaries" }
    );

    const afterRevocation = await recallMemory(memory, scopeRequest);
    expect(afterRevocation.assertions).toEqual([]);
    expect(afterRevocation.exclusions).toEqual([{ reason: "evidence_unauthorized", count: 1 }]);
    // Retrieval is denied too, so neither surface can restate the content.
    expect((await ask({ sources, index, now }, "user-hr")).candidates).toEqual([]);
  });

  it("stops recalling a memory whose supporting source moved to a new revision", async () => {
    const { sink, memory } = wire();
    await ingest(sink);
    const scopeRequest = { businessId: "biz-1", principalId: "user-hr" };
    await rememberMemory(
      memory,
      {
        target: { scope: "user_private", businessId: "biz-1", subjectPrincipalId: "user-hr" },
        subject: "compensation",
        statement: "the salary band was confirmed",
        confidence: 1,
        provenance: {
          origin: "explicit",
          authorPrincipalId: "user-hr",
          evidence: [
            {
              kind: "knowledge_source",
              ref: "google-drive:salaries#0",
              sourceId: "google-drive:salaries",
              revision: "7",
            },
          ],
        },
      },
      scopeRequest
    );

    await sink.emitSource({ ...emission, revision: "8" });

    const result = await recallMemory(memory, scopeRequest);
    expect(result.assertions).toEqual([]);
    expect(result.exclusions).toEqual([{ reason: "evidence_unauthorized", count: 1 }]);
  });
});
