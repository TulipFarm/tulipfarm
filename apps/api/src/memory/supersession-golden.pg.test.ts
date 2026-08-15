import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type {
  MemoryContradictionPort,
  MemoryDeps,
  MemoryOrigin,
  MemoryStatus,
  MemoryTrustTier,
  MemoryType,
} from "@tulipfarm/memory";
import {
  PgMemoryAssertionStore,
  PgPendingMemoryStore,
  recallMemory,
  rememberMemory,
} from "@tulipfarm/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

interface GoldenSupersessionEvent {
  readonly id: string;
  readonly at: string;
  readonly subject: string;
  readonly statement: string;
  readonly memoryType: MemoryType;
  readonly trustTier: MemoryTrustTier;
  readonly origin: MemoryOrigin;
  readonly confidence: number;
  readonly importance: number;
  readonly validFrom: string;
  readonly entities: readonly string[];
}

interface GoldenSupersessionCase {
  readonly id: string;
  readonly title: string;
  readonly principalId: string;
  readonly judge: "always" | "employer-only" | "never";
  readonly events: readonly GoldenSupersessionEvent[];
  readonly now: string;
  readonly expected: {
    readonly currentOrder: readonly string[];
    readonly historical: readonly { readonly validAt: string; readonly order: readonly string[] }[];
    readonly statuses: readonly {
      readonly id: string;
      readonly status: MemoryStatus;
      readonly validTo?: string;
    }[];
  };
}

interface GoldenFixtures {
  readonly supersessionCases: readonly GoldenSupersessionCase[];
}

const BUSINESS_ID = "golden-biz";

function loadFixtures(): GoldenFixtures {
  return JSON.parse(readFileSync("../../packages/memory/test/golden/fixtures.json", "utf8"));
}

function judgeFor(fixture: GoldenSupersessionCase): MemoryContradictionPort {
  return {
    async contradicts(input) {
      if (fixture.judge === "never") return [];
      if (fixture.judge === "employer-only" && input.statement.subject !== "employer") return [];
      return input.priors.map((prior) => prior.assertionId);
    },
  };
}

describe("Memory supersession golden set", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makeMigratedPglite();
  });

  afterEach(async () => {
    await db.close();
  });

  for (const fixture of loadFixtures().supersessionCases) {
    it(`${fixture.id}: ${fixture.title}`, async () => {
      let now = new Date(fixture.events[0]?.at ?? fixture.now);
      let nextId = 0;
      const store = new PgMemoryAssertionStore(db);
      const deps: MemoryDeps = {
        store,
        pending: new PgPendingMemoryStore(db),
        settings: {
          scopes: ["user_private"],
          inferredDurableMemory: { enabled: true, confirmationRequired: true },
        },
        contradiction: judgeFor(fixture),
        now: () => now,
        newId: () => fixture.events[nextId]?.id ?? `unexpected-${nextId}`,
      };
      const target = {
        scope: "user_private" as const,
        businessId: BUSINESS_ID,
        subjectPrincipalId: fixture.principalId,
      };
      const scopeRequest = { businessId: BUSINESS_ID, principalId: fixture.principalId };

      for (const event of fixture.events) {
        now = new Date(event.at);
        const result = await rememberMemory(
          deps,
          {
            target,
            subject: event.subject,
            statement: event.statement,
            memoryType: event.memoryType,
            trustTier: event.trustTier,
            confidence: event.confidence,
            importance: event.importance,
            validFrom: event.validFrom,
            entities: event.entities,
            provenance: {
              origin: event.origin,
              authorPrincipalId: fixture.principalId,
              evidence: [{ kind: "message", ref: `${event.id}:message` }],
            },
          },
          scopeRequest
        );
        expect(result.outcome, `${fixture.id}:${event.id} save outcome`).toBe("saved");
        nextId += 1;
      }

      now = new Date(fixture.now);
      const current = await recallMemory(deps, scopeRequest);
      expect(
        current.assertions.map((assertion) => assertion.assertionId),
        `${fixture.id} current recall`
      ).toEqual(fixture.expected.currentOrder);

      for (const historical of fixture.expected.historical) {
        const result = await recallMemory(deps, { ...scopeRequest, validAt: historical.validAt });
        expect(
          result.assertions.map((assertion) => assertion.assertionId),
          `${fixture.id} historical ${historical.validAt}`
        ).toEqual(historical.order);
      }

      for (const expected of fixture.expected.statuses) {
        const assertion = await store.get(BUSINESS_ID, expected.id);
        expect(assertion?.status, `${fixture.id}:${expected.id} status`).toBe(expected.status);
        if (expected.validTo !== undefined) {
          expect(assertion?.validTo, `${fixture.id}:${expected.id} validTo`).toBe(expected.validTo);
        }
      }
    });
  }
});
