import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { RoutineCatalog } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import type { RunReader } from "../admin/run-reader";
import type { RunReadModel } from "../admin/types";
import { routineRunGetTool, routineRunListTool } from "./routine-run-tools";
import type { PlatformToolContext } from "./tools";

const ROUTINE_ID = "00000000-0000-4000-8000-000000000101";

function runModel(overrides: Partial<RunReadModel> = {}): RunReadModel {
  return {
    id: "cd7a9f0b-d9f0-45c0-ba32-14d978373eea",
    routineId: ROUTINE_ID,
    routineVersion: "5",
    status: "failed",
    version: 3,
    createdAt: "2026-09-05T15:16:22.160Z",
    startedAt: "2026-09-05T15:16:28.843Z",
    finishedAt: "2026-09-05T15:16:28.882Z",
    states: [
      {
        key: "LoadQuoteHistory",
        status: "failed",
        attempts: 1,
        errorEvidenceRef: "routine:input_not_evaluable:PostEngineeringQuote",
      },
    ],
    effects: [],
    waits: [],
    guardrailDecisions: [],
    lineage: [],
    costs: { amountUsd: 0, modelTokens: 0 },
    ...overrides,
  };
}

function ctx(reader: Partial<RunReader>, catalogId: string | null = ROUTINE_ID) {
  return {
    soulWriter: {},
    runs: reader as RunReader,
    routineCatalog: {
      list: async () => [],
      get: async (slug: string) =>
        catalogId === null ? undefined : { id: catalogId, slug, triggers: [] },
    } as unknown as RoutineCatalog,
  } as unknown as PlatformToolContext;
}

describe("routineRunGetTool", () => {
  it("explains the evidence ref and names the State that stopped the Run", async () => {
    const res = await routineRunGetTool.handler(
      { runId: runModel().id },
      ctx({ get: async () => runModel() })
    );
    expect(res.success).toBe(true);
    if (!res.success) throw new Error("expected success");
    const data = res.data as Record<string, unknown>;
    expect(data.status).toBe("failed");
    const error = data.error as Record<string, string>;
    expect(error.state).toBe("LoadQuoteHistory");
    expect(error.explanation).toContain("does not exist at run time");
    expect(error.explanation).toContain("PostEngineeringQuote");
  });

  it("spells out that needs_reconciliation will never finish on its own", async () => {
    const res = await routineRunGetTool.handler(
      { runId: runModel().id },
      ctx({ get: async () => runModel({ status: "needs_reconciliation", finishedAt: null }) })
    );
    if (!res.success) throw new Error("expected success");
    expect((res.data as Record<string, string>).statusMeaning).toContain("needs an operator");
  });

  it("returns not_found for a run id this business does not own", async () => {
    const res = await routineRunGetTool.handler(
      { runId: "missing" },
      ctx({ get: async () => null })
    );
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("reports the Run reader being unavailable rather than an empty answer", async () => {
    const res = await routineRunGetTool.handler({ runId: "x" }, {
      soulWriter: {},
    } as unknown as PlatformToolContext);
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
  });
});

describe("routineRunListTool", () => {
  it("filters by the Routine id the catalogue resolves the slug to", async () => {
    let seen: string | undefined;
    const res = await routineRunListTool.handler(
      { name: "engineering-motivation-quotes", limit: 3 },
      ctx({
        list: async (businessId, options) => {
          expect(businessId).toBe(DEPLOYMENT_BUSINESS_ID);
          expect(options.limit).toBe(3);
          seen = options.routineId;
          return { items: [runModel()], nextCursor: null };
        },
        get: async () => runModel(),
      })
    );
    expect(seen).toBe(ROUTINE_ID);
    if (!res.success) throw new Error("expected success");
    const data = res.data as { runs: Record<string, unknown>[] };
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0]?.status).toBe("failed");
  });

  it("returns not_found when the Routine slug is unknown", async () => {
    const res = await routineRunListTool.handler(
      { name: "nope" },
      ctx({ list: async () => ({ items: [], nextCursor: null }) }, null)
    );
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });
});
