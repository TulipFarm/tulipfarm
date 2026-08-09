import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type { MemoryCandidate, MemoryExtractionPort } from "@tulipfarm/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { MemoryExtractionService } from "./extraction-service";

interface GoldenMemoryCandidate extends MemoryCandidate {
  readonly id: string;
}

interface GoldenExtractionCase {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly injectionFragments?: readonly string[];
  readonly candidates: readonly GoldenMemoryCandidate[];
  readonly expected: {
    readonly proposed: readonly string[];
    readonly rejected: readonly { readonly id: string; readonly reason: string }[];
  };
}

interface GoldenFixtures {
  readonly extractionCases: readonly GoldenExtractionCase[];
}

const USER_ID = "11111111-1111-1111-1111-111111111111";

function loadFixtures(): GoldenFixtures {
  return JSON.parse(readFileSync("../../packages/memory/test/golden/fixtures.json", "utf8"));
}

class StubExtractor implements MemoryExtractionPort {
  constructor(private candidates: readonly MemoryCandidate[] = []) {}

  set(candidates: readonly MemoryCandidate[]): void {
    this.candidates = candidates;
  }

  async extract(): Promise<readonly MemoryCandidate[]> {
    return this.candidates;
  }
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

describe("MemoryExtractionService golden set", () => {
  let db: PGlite;
  let extractor: StubExtractor;
  let now: Date;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    extractor = new StubExtractor();
    now = new Date("2026-08-01T12:00:00.000Z");
  });

  afterEach(async () => {
    await db.close();
  });

  async function assertionCount(): Promise<number> {
    const res = await db.query<{ n: string }>("select count(*)::text as n from memory_assertions");
    return Number(res.rows[0]?.n ?? "0");
  }

  for (const fixture of loadFixtures().extractionCases) {
    it(`${fixture.id}: ${fixture.title}`, async () => {
      extractor.set(fixture.candidates);
      const guardrails = {
        runInput: async (text: string) => ({
          blocked: (fixture.injectionFragments ?? []).some((fragment) => text.includes(fragment)),
        }),
      };
      const service = new MemoryExtractionService(
        db,
        extractor,
        guardrails as never,
        undefined,
        () => now
      );

      const result = await service.extractFromTurn({
        userId: USER_ID,
        agentId: "golden-agent",
        runId: `run-${fixture.id}`,
        messages: fixture.messages,
        evidence: [{ kind: "message", ref: `${fixture.id}:turn` }],
      });

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
      expect(await assertionCount(), `${fixture.id} durable assertions`).toBe(0);
      expect(await service.listPending(USER_ID), `${fixture.id} pending count`).toHaveLength(
        fixture.expected.proposed.length
      );
    });
  }
});
