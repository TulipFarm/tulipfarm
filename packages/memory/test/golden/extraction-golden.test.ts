import { describe, expect, it } from "vitest";
import { InMemoryPendingMemoryStore } from "../../src/confirm";
import { proposeMemoryCandidates } from "../../src/extract";
import { InMemoryMemoryStore, type MemoryDeps, type MemorySettingsView } from "../../src/memory";
import type { MemoryScopeRequest, MemoryScopeTarget } from "../../src/scope";
import { type GoldenMemoryCandidate, goldenFixtures } from "./fixtures";

const BUSINESS_ID = "golden-biz";
const USER_ID = "user-alice";

const TARGET: MemoryScopeTarget = {
  scope: "user_private",
  businessId: BUSINESS_ID,
  subjectPrincipalId: USER_ID,
};

const SCOPE_REQUEST: MemoryScopeRequest = {
  businessId: BUSINESS_ID,
  principalId: USER_ID,
};

const SETTINGS: MemorySettingsView = {
  scopes: ["user_private"],
  inferredDurableMemory: { enabled: true, confirmationRequired: true },
};

function deps(): MemoryDeps {
  let counter = 0;
  return {
    store: new InMemoryMemoryStore(),
    pending: new InMemoryPendingMemoryStore(),
    settings: SETTINGS,
    now: () => new Date("2026-08-01T12:00:00.000Z"),
    newId: () => `pending-${++counter}`,
  };
}

function candidateId(
  fixtureCandidates: readonly GoldenMemoryCandidate[],
  subject: string,
  statement: string
): string {
  const found = fixtureCandidates.find(
    (candidate) => candidate.subject === subject && candidate.statement === statement
  );
  return found?.id ?? `missing:${subject}:${statement}`;
}

describe("memory extraction golden set", () => {
  for (const fixture of goldenFixtures.extractionCases) {
    it(`${fixture.id}: ${fixture.title}`, async () => {
      const d = deps();
      const screen = {
        isInjection(text: string): boolean {
          return (fixture.injectionFragments ?? []).some((fragment) => text.includes(fragment));
        },
      };

      const result = await proposeMemoryCandidates(
        d,
        {
          target: TARGET,
          candidates: fixture.candidates,
          authorPrincipalId: USER_ID,
          authorAgentId: "golden-agent",
          runId: `run-${fixture.id}`,
          evidence: [{ kind: "message", ref: `${fixture.id}:turn` }],
        },
        SCOPE_REQUEST,
        screen
      );

      const proposedIds = result.proposed.map((proposed) =>
        candidateId(fixture.candidates, proposed.candidate.subject, proposed.candidate.statement)
      );
      const rejected = result.rejected.map((rejection) => ({
        id: candidateId(
          fixture.candidates,
          rejection.candidate.subject,
          rejection.candidate.statement
        ),
        reason: rejection.reason,
      }));

      expect(proposedIds, `${fixture.id} proposed candidates`).toEqual(fixture.expected.proposed);
      expect(rejected, `${fixture.id} rejected candidates`).toEqual(fixture.expected.rejected);
      expect(await d.store.list(BUSINESS_ID), `${fixture.id} assertion store`).toEqual([]);

      for (const proposed of result.proposed) {
        const pending = await d.pending.get(BUSINESS_ID, proposed.pendingId);
        expect(pending?.request.provenance.origin, `${fixture.id} pending origin`).toBe("inferred");
      }
    });
  }
});
