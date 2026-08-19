/**
 * Proves the unified gate governs authored Pages exactly as it governs synced Sources: a denied
 * Page is absent rather than redacted, and changes nothing observable except the aggregate count.
 */

import type { AuditEventInput } from "@tulipfarm/audit";
import type { CachePort } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeIndex } from "../../src/indexing";
import type { KnowledgeAuditSink, RetrievalDeps, RetrievalResult } from "../../src/retrieve";
import { retrieve } from "../../src/retrieve";
import type { KnowledgePrincipalRef } from "../../src/source";
import { InMemoryKnowledgeSourceStore } from "../../src/source";
import type { KnowledgeAclEntry, KnowledgeSubject } from "../../src/subject";
import { InMemoryKnowledgeSubjectStore, pageSubject } from "../../src/subject";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const now = () => NOW;

/** Planted in the restricted Page; any serialized appearance anywhere is a leak. */
const SECRETS = ["board-minutes", "acquisition of northwind", "acl-board", "space-board"] as const;

const SPACE_OPEN = "space-handbook";
const SPACE_BOARD = "space-board";
const PAGE_OPEN = "page-handbook";
const PAGE_BOARD = "board-minutes";

const alice: KnowledgePrincipalRef = { kind: "user", id: "alice" };
const everyone: KnowledgePrincipalRef = { kind: "role", id: "role-everyone" };
const board: KnowledgePrincipalRef = { kind: "group", id: "group-board" };

function entry(
  subjectKind: "space" | "page",
  subjectId: string,
  principal: KnowledgePrincipalRef,
  effect: "grant" | "deny"
): KnowledgeAclEntry {
  return { subjectKind, subjectId, principal, effect, capability: "read" };
}

function openPage(entries: readonly KnowledgeAclEntry[]): KnowledgeSubject {
  return pageSubject(
    {
      pageId: PAGE_OPEN,
      spaceId: SPACE_OPEN,
      businessId: "biz-1",
      revision: "3",
      aclRevision: "acl-open",
      status: "active",
    },
    entries,
    NOW
  );
}

function boardPage(
  entries: readonly KnowledgeAclEntry[],
  status: "active" | "revoked" | "deleted" = "active"
): KnowledgeSubject {
  return pageSubject(
    {
      pageId: PAGE_BOARD,
      spaceId: SPACE_BOARD,
      businessId: "biz-1",
      revision: "9",
      aclRevision: "acl-board",
      status,
    },
    entries,
    NOW
  );
}

class RecordingAudit implements KnowledgeAuditSink {
  readonly events: AuditEventInput[] = [];
  async record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}

class MapCache implements CachePort {
  readonly entries = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.entries.get(key) as T | undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

interface Harness {
  readonly deps: RetrievalDeps;
  readonly subjects: InMemoryKnowledgeSubjectStore;
  readonly audit: RecordingAudit;
  readonly cache: MapCache;
}

async function harness(
  pages: readonly KnowledgeSubject[],
  options: { readonly groupsOf?: Record<string, readonly KnowledgePrincipalRef[]> } = {}
): Promise<Harness> {
  const index = new InMemoryKnowledgeIndex();
  await index.upsert({
    businessId: "biz-1",
    sourceId: PAGE_OPEN,
    chunkId: `${PAGE_OPEN}#0`,
    revision: "3",
    classification: ["internal"],
    digest: "d".repeat(64),
    text: "the company plan for the year is published each january",
  });
  await index.upsert({
    businessId: "biz-1",
    sourceId: PAGE_BOARD,
    chunkId: `${PAGE_BOARD}#0`,
    revision: "9",
    classification: ["restricted"],
    digest: "e".repeat(64),
    text: "the plan approves the acquisition of northwind for 40m",
  });
  const subjects = new InMemoryKnowledgeSubjectStore(pages);
  const audit = new RecordingAudit();
  const cache = new MapCache();
  const groupsOf = options.groupsOf;
  return {
    subjects,
    audit,
    cache,
    deps: {
      sources: new InMemoryKnowledgeSourceStore([]),
      index,
      subjects,
      audit,
      cache,
      now,
      access: { authoredPagesInRetrieval: true, maxAclEntriesPerSubject: 1000 },
      ...(groupsOf === undefined
        ? {}
        : {
            principalResolver: {
              async resolve(input: { principals: readonly KnowledgePrincipalRef[] }) {
                const extra = input.principals.flatMap(
                  (principal) => groupsOf[`${principal.kind}:${principal.id}`] ?? []
                );
                return [...input.principals, ...extra];
              },
            },
          }),
    },
  };
}

function ask(
  deps: RetrievalDeps,
  principals: readonly KnowledgePrincipalRef[]
): Promise<RetrievalResult> {
  return retrieve(deps, {
    businessId: "biz-1",
    principalId: "alice",
    principals,
    query: "plan",
    limit: 10,
    guardrailEpoch: "g1",
    contextEpoch: "c1",
    correlationId: "corr-1",
  });
}

function expectNoDisclosure(...payloads: unknown[]): void {
  const serialized = payloads.map((payload) => JSON.stringify(payload) ?? "").join("\n");
  for (const secret of SECRETS) expect(serialized).not.toContain(secret);
}

const ids = (result: RetrievalResult) => result.candidates.map((c) => c.sourceId);

describe("authored Page authorization through retrieve()", () => {
  it("returns a Page granted at its Space and withholds one that is not", async () => {
    const { deps, audit } = await harness([
      openPage([entry("space", SPACE_OPEN, everyone, "grant")]),
      boardPage([entry("space", SPACE_BOARD, board, "grant")]),
    ]);
    const result = await ask(deps, [alice, everyone]);
    expect(ids(result)).toEqual([PAGE_OPEN]);
    expectNoDisclosure(result, audit.events);
  });

  it("withholds a Page whose Space denies, even when the Page itself grants", async () => {
    const { deps, audit } = await harness([
      openPage([entry("space", SPACE_OPEN, everyone, "grant")]),
      boardPage([
        entry("space", SPACE_BOARD, everyone, "deny"),
        entry("page", PAGE_BOARD, everyone, "grant"),
      ]),
    ]);
    const result = await ask(deps, [alice, everyone]);
    expect(ids(result)).toEqual([PAGE_OPEN]);
    expectNoDisclosure(result, audit.events);
  });

  it("withholds a Page denied by its own override against a Space grant", async () => {
    const { deps } = await harness([
      openPage([entry("space", SPACE_OPEN, everyone, "grant")]),
      boardPage([
        entry("space", SPACE_BOARD, everyone, "grant"),
        entry("page", PAGE_BOARD, alice, "deny"),
      ]),
    ]);
    expect(ids(await ask(deps, [alice, everyone]))).toEqual([PAGE_OPEN]);
  });

  it("returns a Page granted only by its own override where the Space is silent", async () => {
    const { deps } = await harness([
      openPage([entry("space", SPACE_OPEN, everyone, "grant")]),
      boardPage([entry("page", PAGE_BOARD, alice, "grant")]),
    ]);
    expect(ids(await ask(deps, [alice, everyone])).sort()).toEqual([PAGE_BOARD, PAGE_OPEN].sort());
  });

  it("withholds a Page carrying no entries at all", async () => {
    const { deps, audit } = await harness([
      openPage([entry("space", SPACE_OPEN, everyone, "grant")]),
      boardPage([]),
    ]);
    const result = await ask(deps, [alice, everyone]);
    expect(ids(result)).toEqual([PAGE_OPEN]);
    expectNoDisclosure(result, audit.events);
  });

  it.each(["revoked", "deleted"] as const)(
    "withholds a %s Page even where the ACL would allow it",
    async (status) => {
      const { deps } = await harness([
        openPage([entry("space", SPACE_OPEN, everyone, "grant")]),
        boardPage([entry("space", SPACE_BOARD, everyone, "grant")], status),
      ]);
      expect(ids(await ask(deps, [alice, everyone]))).toEqual([PAGE_OPEN]);
    }
  );
});

describe("group membership resolved at query time", () => {
  const groupsOf = { "user:alice": [board] };

  it("admits a member of the granted group", async () => {
    const { deps } = await harness(
      [
        openPage([entry("space", SPACE_OPEN, everyone, "grant")]),
        boardPage([entry("space", SPACE_BOARD, board, "grant")]),
      ],
      { groupsOf }
    );
    expect(ids(await ask(deps, [alice, everyone])).sort()).toEqual([PAGE_BOARD, PAGE_OPEN].sort());
  });

  it("withholds it from the same person once they leave the group", async () => {
    const { deps } = await harness(
      [
        openPage([entry("space", SPACE_OPEN, everyone, "grant")]),
        boardPage([entry("space", SPACE_BOARD, board, "grant")]),
      ],
      { groupsOf: {} }
    );
    expect(ids(await ask(deps, [alice, everyone]))).toEqual([PAGE_OPEN]);
  });

  it("gives a member and a non-member different cache keys", async () => {
    const member = await harness([openPage([entry("space", SPACE_OPEN, everyone, "grant")])], {
      groupsOf,
    });
    const outsider = await harness([openPage([entry("space", SPACE_OPEN, everyone, "grant")])], {
      groupsOf: {},
    });
    const one = await ask(member.deps, [alice, everyone]);
    const two = await ask(outsider.deps, [alice, everyone]);
    expect(one.cacheKey).not.toBe(two.cacheKey);
  });
});

describe("the denied Page is a side channel of nothing but the aggregate count", () => {
  async function observable(pages: readonly KnowledgeSubject[]): Promise<{
    result: RetrievalResult;
    audit: readonly AuditEventInput[];
  }> {
    const { deps, audit } = await harness(pages);
    const result = await ask(deps, [alice, everyone]);
    return { result, audit: audit.events };
  }

  const open = () => openPage([entry("space", SPACE_OPEN, everyone, "grant")]);

  it("matches a world where the denied Page never existed, except the exclusion count", async () => {
    const withDenied = await observable([open(), boardPage([])]);
    const without = await observable([open()]);

    expect(withDenied.result.candidates).toEqual(without.result.candidates);
    expect(withDenied.result.cacheKey).toBe(without.result.cacheKey);
    expect(withDenied.result.exclusions.map((e) => e.reason)).toEqual(["principal_not_permitted"]);
    expect(without.result.exclusions).toEqual([]);

    const strip = (events: readonly AuditEventInput[]) =>
      events.map((event) => ({
        ...event,
        reasonCodes: undefined,
        safeMetadata: { ...event.safeMetadata, excludedCount: undefined },
      }));
    expect(strip(withDenied.audit)).toEqual(strip(without.audit));
  });

  it("reports an explicit deny and an absent grant identically", async () => {
    const denied = await observable([
      open(),
      boardPage([entry("space", SPACE_BOARD, alice, "deny")]),
    ]);
    const ungranted = await observable([open(), boardPage([])]);
    expect(JSON.stringify(denied.result)).toBe(JSON.stringify(ungranted.result));
  });
});

describe("the authored-Page flag", () => {
  it("keeps Pages out of retrieval entirely when it is off", async () => {
    const { deps } = await harness([openPage([entry("space", SPACE_OPEN, everyone, "grant")])]);
    const off: RetrievalDeps = {
      ...deps,
      access: { authoredPagesInRetrieval: false, maxAclEntriesPerSubject: 1000 },
    };
    const result = await ask(off, [alice, everyone]);
    expect(result.candidates).toEqual([]);
  });

  it("defaults to off when no access config is composed", async () => {
    const { deps } = await harness([openPage([entry("space", SPACE_OPEN, everyone, "grant")])]);
    const { access: _access, ...bare } = deps;
    const result = await ask(bare as RetrievalDeps, [alice, everyone]);
    expect(result.candidates).toEqual([]);
  });
});

describe("warm caches never outlive the permission that filled them", () => {
  it("stops answering once the Page is revoked", async () => {
    const { deps, subjects } = await harness([
      openPage([entry("space", SPACE_OPEN, everyone, "grant")]),
      boardPage([entry("space", SPACE_BOARD, everyone, "grant")]),
    ]);
    expect(ids(await ask(deps, [alice, everyone])).sort()).toEqual([PAGE_BOARD, PAGE_OPEN].sort());

    await subjects.put(boardPage([entry("space", SPACE_BOARD, everyone, "grant")], "revoked"));
    const after = await ask(deps, [alice, everyone]);
    expect(ids(after)).toEqual([PAGE_OPEN]);
    expectNoDisclosure(after);
  });

  it("stops answering once the grant is withdrawn", async () => {
    const { deps, subjects } = await harness([
      openPage([entry("space", SPACE_OPEN, everyone, "grant")]),
      boardPage([entry("space", SPACE_BOARD, everyone, "grant")]),
    ]);
    await ask(deps, [alice, everyone]);

    await subjects.put(boardPage([entry("space", SPACE_BOARD, everyone, "deny")]));
    expect(ids(await ask(deps, [alice, everyone]))).toEqual([PAGE_OPEN]);
  });

  it("stops answering once the Page is deleted from the store", async () => {
    const { deps, subjects } = await harness([
      openPage([entry("space", SPACE_OPEN, everyone, "grant")]),
      boardPage([entry("space", SPACE_BOARD, everyone, "grant")]),
    ]);
    await ask(deps, [alice, everyone]);

    await subjects.delete("biz-1", PAGE_BOARD);
    expect(ids(await ask(deps, [alice, everyone]))).toEqual([PAGE_OPEN]);
  });
});

describe("pathological ACLs fail closed", () => {
  it("denies a subject carrying more entries than the configured ceiling", async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      entry("space", SPACE_BOARD, { kind: "user", id: `filler-${i}` }, "grant")
    );
    const { deps } = await harness([
      openPage([entry("space", SPACE_OPEN, everyone, "grant")]),
      boardPage([...many, entry("space", SPACE_BOARD, everyone, "grant")]),
    ]);
    const capped: RetrievalDeps = {
      ...deps,
      access: { authoredPagesInRetrieval: true, maxAclEntriesPerSubject: 10 },
    };
    expect(ids(await ask(capped, [alice, everyone]))).toEqual([PAGE_OPEN]);
  });
});
