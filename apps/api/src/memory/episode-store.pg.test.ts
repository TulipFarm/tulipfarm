import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  MemoryExtractionService,
  MemoryRecallService,
  PgMemoryEpisodeStore,
} from "@tulipfarm/memory";
import type { Attributes, Span, TelemetryPort } from "@tulipfarm/observability";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

class EmptyExtractor {
  async extract(): Promise<[]> {
    return [];
  }
}

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER_USER = "22222222-2222-2222-2222-222222222222";

interface CapturedTelemetry {
  readonly name: string;
  readonly value?: number;
  readonly attributes?: Attributes;
}

function capturingTelemetry(records: CapturedTelemetry[]): TelemetryPort {
  function span(name: string, attributes: Attributes): Span {
    records.push({ name, attributes });
    return {
      setAttributes(next) {
        records.push({ name: `${name}.attributes`, attributes: next });
      },
      recordError(code) {
        records.push({ name: `${name}.error`, attributes: { code } });
      },
      end() {
        records.push({ name: `${name}.end` });
      },
    };
  }
  return {
    startSpan(name, attributes = {}) {
      return span(name, attributes);
    },
    counter(name, value = 1, attributes = {}) {
      records.push({ name, value, attributes });
    },
    histogram(name, value, attributes = {}) {
      records.push({ name, value, attributes });
    },
    gauge(name, value, attributes = {}) {
      records.push({ name, value, attributes });
    },
    log(level) {
      records.push({ name: level });
    },
  };
}

describe("PgMemoryEpisodeStore", () => {
  let db: PGlite;
  let episodes: PgMemoryEpisodeStore;
  let recall: MemoryRecallService;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    episodes = new PgMemoryEpisodeStore(db);
    recall = new MemoryRecallService(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("makes a decision from chat A recallable in chat B", async () => {
    await episodes.recordConversationEpisode({
      principalId: USER,
      target: {
        scope: "user_private",
        businessId: DEPLOYMENT_BUSINESS_ID,
        subjectPrincipalId: USER,
      },
      conversationId: "chat-a-summary",
      summary:
        "Decision: use Cedar for invoice approvals.\nOutcome: the billing migration can proceed.",
      outcome: "compacted from chat A",
    });

    const recalled = await recall.recall(USER, "Cedar invoice approvals", 5);

    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.memoryType).toBe("episodic");
    expect(recalled[0]?.statement).toContain("Cedar");
    const chunks = await db.query<{ n: string }>("select count(*)::text as n from memory_chunks");
    expect(chunks.rows[0]?.n).toBe("3");
  });

  it("never crosses user-private scope boundaries", async () => {
    await episodes.recordConversationEpisode({
      principalId: USER,
      target: {
        scope: "user_private",
        businessId: DEPLOYMENT_BUSINESS_ID,
        subjectPrincipalId: USER,
      },
      conversationId: "private-chat",
      summary: "Decision: launch Project Tulip with the private pricing plan.",
    });

    expect(await recall.recall(OTHER_USER, "Project Tulip private pricing", 5)).toEqual([]);
    expect(await recall.recall(USER, "Project Tulip private pricing", 5)).toHaveLength(1);
  });

  it("requires both the user and Agent for user-agent Episodes", async () => {
    await episodes.recordConversationEpisode({
      principalId: USER,
      agentId: "sales-agent",
      target: {
        scope: "user_agent",
        businessId: DEPLOYMENT_BUSINESS_ID,
        subjectPrincipalId: USER,
        agentId: "sales-agent",
      },
      conversationId: "agent-chat",
      summary: "Decision: sales-agent should use the Dahlia follow-up plan for Acme.",
    });

    expect(await recall.recall(USER, "Dahlia follow-up plan", 5)).toEqual([]);
    expect(await recall.recall(USER, "Dahlia follow-up plan", 5, "support-agent")).toEqual([]);
    expect(await recall.recall(USER, "Dahlia follow-up plan", 5, "sales-agent")).toHaveLength(1);
  });

  it("records a Run Episode from the worker completion path without extracting an Assertion", async () => {
    const extraction = new MemoryExtractionService(
      db,
      new EmptyExtractor(),
      undefined,
      undefined,
      () => new Date("2026-08-08T00:00:00.000Z"),
      undefined,
      episodes
    );

    await extraction.extractFromTurn({
      userId: USER,
      runId: "run-chat-a",
      outcome: "succeeded",
      messages: [
        { role: "user", content: "Please choose the rollout plan." },
        { role: "assistant", content: "Decision: use the Iris rollout plan for launch." },
      ],
    });

    const recalled = await recall.recall(USER, "Iris rollout plan", 5);
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.memoryType).toBe("episodic");
  });

  it("emits episode telemetry without content, ids, or principals", async () => {
    const records: CapturedTelemetry[] = [];
    const telemetry = capturingTelemetry(records);
    const instrumentedEpisodes = new PgMemoryEpisodeStore(
      db,
      undefined,
      () => new Date("2026-08-08T00:00:00.000Z"),
      telemetry
    );
    const instrumentedRecall = new MemoryRecallService(db, undefined, telemetry);
    const conversationId = "sensitive-conversation-violet";
    const summary = "Episode summary contains the private saffron launch plan.";
    const decision = "Decision chunk contains the confidential orchid migration.";

    await instrumentedEpisodes.recordConversationEpisode({
      principalId: USER,
      target: {
        scope: "user_private",
        businessId: DEPLOYMENT_BUSINESS_ID,
        subjectPrincipalId: USER,
      },
      conversationId,
      summary,
      decisions: [decision],
      outcome: "Outcome says the saffron launch succeeded.",
    });
    await instrumentedRecall.recall(USER, "confidential orchid migration", 5);

    const serialized = JSON.stringify(records);
    for (const forbidden of [USER, conversationId, summary, decision]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain("tulipfarm.memory.episodes.writes");
    expect(serialized).toContain("tulipfarm.memory.episodes.chunks");
    expect(serialized).toContain("tulipfarm.memory.episodes.recall_candidates");
  });
});
