import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import { InternalApiClient } from "../internal/client";
import { createRoutineToolPort } from "./tool-factory";
import { BrokerRoutineToolPort } from "./tool-port";

describe("createRoutineToolPort", () => {
  it("is used by the Worker composition root with the shared durable wait host", () => {
    const source = readFileSync(join(__dirname, "../main.ts"), "utf8");
    const factoryCallStart = source.indexOf("createRoutineToolPort({");
    const factoryCallEnd = source.indexOf("}),\n        spendSink", factoryCallStart);
    const factoryCall = source.slice(factoryCallStart, factoryCallEnd);

    expect(factoryCallStart).toBeGreaterThan(-1);
    expect(factoryCallEnd).toBeGreaterThan(factoryCallStart);
    expect(factoryCall).toContain("internalApi,");
    expect(factoryCall).toContain("parkRetry: effectRetryWaits.parkRetry");
    expect(factoryCall).toContain("retryWaitStatus: effectRetryWaits.status");
    expect(source).not.toContain("new BrokerRoutineToolPort({");
  });

  it("builds the production Broker with mandatory remote MCP and durable retry seams", () => {
    const internalApi = new InternalApiClient({
      baseUrl: "http://api:4010",
      credential: "tfc_client.secret",
      fetch: vi.fn(),
    });

    expect(
      createRoutineToolPort({
        internalApi,
        effects: new MemoryEffectStore(),
        approvals: {
          decide: vi.fn(),
          consume: vi.fn(),
        },
        adapters: new Map(),
        parkRetry: vi.fn(),
        retryWaitStatus: vi.fn(),
      })
    ).toBeInstanceOf(BrokerRoutineToolPort);
  });
});
