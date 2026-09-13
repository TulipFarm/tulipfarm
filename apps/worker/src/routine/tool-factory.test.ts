import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import { InternalApiClient } from "../internal/client";
import { createRoutineToolPort } from "./tool-factory";
import { BrokerRoutineToolPort } from "./tool-port";

describe("createRoutineToolPort", () => {
  it("builds the production Broker with mandatory remote OIM and durable retry seams", () => {
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
