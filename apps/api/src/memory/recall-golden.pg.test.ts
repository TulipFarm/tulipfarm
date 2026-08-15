import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type {
  MemoryAssertion,
  MemoryConfirmationState,
  MemoryDeps,
  MemoryEmbedder,
  MemoryExclusionReason,
  MemoryOrigin,
  MemoryStatus,
  MemoryTrustTier,
  MemoryType,
} from "@tulipfarm/memory";
import {
  PgMemoryAssertionStore,
  PgMemoryRecallIndex,
  PgPendingMemoryStore,
  recallMemory,
} from "@tulipfarm/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

interface GoldenRecallAssertion {
  readonly id: string;
  readonly targetPrincipalId?: string;
  readonly subject: string;
  readonly statement: string;
  readonly memoryType: MemoryType;
  readonly trustTier: MemoryTrustTier;
  readonly confidence: number;
  readonly importance: number;
  readonly origin: MemoryOrigin;
  readonly authorPrincipalId: string;
  readonly confirmation?: MemoryConfirmationState;
  readonly status?: MemoryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly expiresAt?: string;
  readonly entities: readonly string[];
}

interface GoldenRecallCase {
  readonly id: string;
  readonly title: string;
  readonly now: string;
  readonly principalId: string;
  readonly query?: string;
  readonly limit: number;
  readonly useIndex: boolean;
  readonly corpus: readonly GoldenRecallAssertion[];
  readonly expected: {
    readonly order: readonly string[];
    readonly exclusions?: readonly {
      readonly reason: MemoryExclusionReason;
      readonly count: number;
    }[];
  };
}

interface GoldenFixtures {
  readonly recallCases: readonly GoldenRecallCase[];
}

const BUSINESS_ID = "golden-biz";
const DEFAULT_PRINCIPAL_ID = "user-alice";
const VOCAB = [
  "priya",
  "project",
  "atlas",
  "launch",
  "guitar",
  "piano",
  "coffee",
  "preference",
  "espresso",
  "machine",
  "meeting",
];

function loadFixtures(): GoldenFixtures {
  return JSON.parse(readFileSync("../../packages/memory/test/golden/fixtures.json", "utf8"));
}

function bagEmbed(text: string): number[] {
  const words = text.toLowerCase().match(/[a-z0-9+]+/g) ?? [];
  return VOCAB.map((term) => words.filter((word) => word === term).length);
}

const embedder: MemoryEmbedder = {
  isAvailable: () => true,
  async embedMany(values) {
    return { embeddings: values.map((value) => bagEmbed(value)), dimension: VOCAB.length };
  },
  getActive: () => ({ provider: "golden", model: "bag", dimension: VOCAB.length }),
};

function assertionFromFixture(fixture: GoldenRecallAssertion): MemoryAssertion {
  return {
    assertionId: fixture.id,
    businessId: BUSINESS_ID,
    target: {
      scope: "user_private",
      businessId: BUSINESS_ID,
      subjectPrincipalId: fixture.targetPrincipalId ?? DEFAULT_PRINCIPAL_ID,
    },
    subject: fixture.subject,
    statement: fixture.statement,
    memoryType: fixture.memoryType,
    trustTier: fixture.trustTier,
    confidence: fixture.confidence,
    importance: fixture.importance,
    provenance: {
      origin: fixture.origin,
      authorPrincipalId: fixture.authorPrincipalId,
      evidence: [{ kind: "message", ref: `${fixture.id}:message` }],
    },
    confirmation: fixture.confirmation ?? "confirmed",
    status: fixture.status ?? "active",
    version: 1,
    createdAt: fixture.createdAt,
    updatedAt: fixture.updatedAt,
    validFrom: fixture.validFrom,
    ...(fixture.validTo === undefined ? {} : { validTo: fixture.validTo }),
    ...(fixture.expiresAt === undefined ? {} : { expiresAt: fixture.expiresAt }),
    entities: fixture.entities,
    accessCount: 0,
  };
}

function byReason<T extends { readonly reason: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.reason.localeCompare(right.reason));
}

describe("Memory recall golden set", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makeMigratedPglite();
  });

  afterEach(async () => {
    await db.close();
  });

  for (const fixture of loadFixtures().recallCases) {
    it(`${fixture.id}: ${fixture.title}`, async () => {
      const seedingStore = new PgMemoryAssertionStore(db, embedder);
      for (const item of fixture.corpus) {
        await seedingStore.put(assertionFromFixture(item));
      }
      const deps: MemoryDeps = {
        store: new PgMemoryAssertionStore(db),
        pending: new PgPendingMemoryStore(db),
        settings: {
          scopes: ["user_private"],
          inferredDurableMemory: { enabled: true, confirmationRequired: true },
        },
        ...(fixture.useIndex ? { index: new PgMemoryRecallIndex(db, embedder) } : {}),
        now: () => new Date(fixture.now),
        newId: () => "unused",
      };

      const result = await recallMemory(deps, {
        businessId: BUSINESS_ID,
        principalId: fixture.principalId,
        limit: fixture.limit,
        ...(fixture.query === undefined ? {} : { query: fixture.query }),
      });

      expect(
        result.assertions.map((assertion) => assertion.assertionId),
        `${fixture.id} recall order`
      ).toEqual(fixture.expected.order);
      if (fixture.expected.exclusions !== undefined) {
        expect(byReason(result.exclusions), `${fixture.id} exclusions`).toEqual(
          byReason(fixture.expected.exclusions)
        );
      }
    });
  }
});
