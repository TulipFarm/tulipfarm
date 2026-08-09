import { describe, expect, it } from "vitest";
import { InMemoryPendingMemoryStore } from "../../src/confirm";
import type { MemoryContradictionPort } from "../../src/contradiction";
import {
  InMemoryMemoryStore,
  type MemoryDeps,
  type MemorySettingsView,
  rememberMemory,
} from "../../src/memory";
import { recallMemory } from "../../src/retrieve";
import { type GoldenSupersessionCase, goldenFixtures } from "./fixtures";

const BUSINESS_ID = "golden-biz";

const SETTINGS: MemorySettingsView = {
  scopes: ["user_private"],
  inferredDurableMemory: { enabled: true, confirmationRequired: true },
};

function judgeFor(fixture: GoldenSupersessionCase): MemoryContradictionPort {
  return {
    async contradicts(input) {
      if (fixture.judge === "never") return [];
      if (fixture.judge === "employer-only" && input.statement.subject !== "employer") return [];
      return input.priors.map((prior) => prior.assertionId);
    },
  };
}

describe("memory supersession golden set", () => {
  for (const fixture of goldenFixtures.supersessionCases) {
    it(`${fixture.id}: ${fixture.title}`, async () => {
      const store = new InMemoryMemoryStore();
      let now = new Date(fixture.events[0]?.at ?? fixture.now);
      let nextId = 0;
      const deps: MemoryDeps = {
        store,
        pending: new InMemoryPendingMemoryStore(),
        settings: SETTINGS,
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
