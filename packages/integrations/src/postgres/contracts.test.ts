import { ToolCatalog } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import { POSTGRES_ADAPTER_REF, POSTGRES_TOOL_CONTRACTS, POSTGRES_TOOL_IDS } from "./contracts";

describe("PostgreSQL ToolContracts", () => {
  it("publishes separate typed read and mutation contracts through the governed adapter", () => {
    const catalog = ToolCatalog.load(POSTGRES_TOOL_CONTRACTS);

    expect(catalog.get(POSTGRES_TOOL_IDS.read, "1.0.0")).toMatchObject({
      action: POSTGRES_TOOL_IDS.read,
      mutating: false,
      adapter: { kind: "postgres", ref: POSTGRES_ADAPTER_REF },
    });
    expect(catalog.get(POSTGRES_TOOL_IDS.mutate, "1.0.0")).toMatchObject({
      action: POSTGRES_TOOL_IDS.mutate,
      mutating: true,
      idempotency: { strategy: "reconcile" },
      adapter: { kind: "postgres", ref: POSTGRES_ADAPTER_REF },
    });
  });
});
