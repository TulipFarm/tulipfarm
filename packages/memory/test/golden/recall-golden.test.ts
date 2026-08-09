import { describe, expect, it } from "vitest";
import { InMemoryPendingMemoryStore } from "../../src/confirm";
import {
  InMemoryMemoryStore,
  type MemoryAssertion,
  type MemoryDeps,
  type MemorySettingsView,
} from "../../src/memory";
import type { MemoryRecallIndex } from "../../src/retrieve";
import { recallMemory } from "../../src/retrieve";
import { type GoldenRecallAssertion, type GoldenRecallCase, goldenFixtures } from "./fixtures";

const BUSINESS_ID = "golden-biz";
const DEFAULT_PRINCIPAL_ID = "user-alice";

const SETTINGS: MemorySettingsView = {
  scopes: ["user_private"],
  inferredDurableMemory: { enabled: true, confirmationRequired: true },
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

function indexFor(fixture: GoldenRecallCase): MemoryRecallIndex | undefined {
  if (!fixture.useIndex) return undefined;
  return {
    async search() {
      return fixture.signals;
    },
  };
}

function byReason<T extends { readonly reason: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.reason.localeCompare(right.reason));
}

describe("memory recall golden set", () => {
  for (const fixture of goldenFixtures.recallCases) {
    it(`${fixture.id}: ${fixture.title}`, async () => {
      const store = new InMemoryMemoryStore();
      for (const item of fixture.corpus) {
        await store.put(assertionFromFixture(item));
      }
      const deps: MemoryDeps = {
        store,
        pending: new InMemoryPendingMemoryStore(),
        settings: SETTINGS,
        ...(indexFor(fixture) === undefined ? {} : { index: indexFor(fixture) }),
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
