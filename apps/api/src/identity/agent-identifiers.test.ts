import { agentIdOf, DEFAULT_ASSISTANT_NAME, type SoulAgent } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../db";
import { reconcileAgentIdentifiers } from "./agent-identifiers";
import type { SoulAgents } from "./agent-principals";

const BUSINESS = "business-1";

function soulAgent(name: string): SoulAgent {
  return { id: agentIdOf(name, {}), name, frontmatter: {}, body: "" } as SoulAgent;
}

const SUPPORT = soulAgent("support");

function soul(agents: readonly SoulAgent[]): SoulAgents {
  return { agents: new Map(agents.map((agent) => [agent.name, agent])) };
}

/**
 * Reports every column probed with `hasColumn` as present, so `reconcileAgentIdentifiers` walks
 * its full column list. Records every SQL statement issued; a stub can force a table to fail so
 * the failure-handling path is exercised too.
 */
function fakeQueryable(options: { failTable?: string } = {}): { q: Queryable; sql: string[] } {
  const sql: string[] = [];
  const q: Queryable = {
    query: vi.fn(async (text: string) => {
      sql.push(text);
      if (text.includes("information_schema.columns")) {
        return { rows: [{}] };
      }
      if (options.failTable && text.includes(`UPDATE ${options.failTable} `)) {
        throw new Error(`permission denied for table ${options.failTable}`);
      }
      return { rows: [] };
    }),
  } as unknown as Queryable;
  return { q, sql };
}

describe("reconcileAgentIdentifiers", () => {
  it("never issues an UPDATE against audit_events", async () => {
    const { q, sql } = fakeQueryable();

    await reconcileAgentIdentifiers(q, soul([SUPPORT]), BUSINESS);

    expect(sql.some((statement) => statement.includes("audit_events"))).toBe(false);
  });

  it("still re-keys other identifier columns, including the default assistant", async () => {
    const { q, sql } = fakeQueryable();

    await reconcileAgentIdentifiers(q, soul([SUPPORT]), BUSINESS);

    expect(sql.some((statement) => statement.startsWith("UPDATE conversations "))).toBe(true);
    const conversationsUpdates = (q.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([statement]) => (statement as string).startsWith("UPDATE conversations ")
    );
    const renamedIdentifiers = conversationsUpdates.map(([, params]) => (params as unknown[])[1]);
    expect(renamedIdentifiers).toEqual(expect.arrayContaining([DEFAULT_ASSISTANT_NAME, "support"]));
  });

  it("surfaces a rejected rekey through the logger's error level, not warn, and does not throw", async () => {
    const { q } = fakeQueryable({ failTable: "conversations" });
    const logger = { error: vi.fn() };

    await expect(
      reconcileAgentIdentifiers(q, soul([SUPPORT]), BUSINESS, logger)
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not re-key conversations.agent_id for "support"')
    );
  });
});
