import { describe, expect, it } from "vitest";
import { InternalApiClient } from "../internal/client";
import { HttpRoutineOwnerGuard } from "./owner-guard";

describe("HttpRoutineOwnerGuard", () => {
  it("asks the API to derive ownership from the persisted Run", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const client = new InternalApiClient({
      baseUrl: "http://api:4010",
      credential: "tfc_worker.secret",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? "GET" });
        return new Response(JSON.stringify({ status: "allowed", ownership: "team" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof globalThis.fetch,
    });

    await expect(
      new HttpRoutineOwnerGuard(client).check({ runId: "run/with space" })
    ).resolves.toEqual({
      status: "allowed",
      ownership: "team",
    });
    expect(calls).toEqual([
      {
        url: "http://api:4010/api/v1/internal/runs/run%2Fwith%20space/routine-owner-status",
        method: "GET",
      },
    ]);
  });
});
