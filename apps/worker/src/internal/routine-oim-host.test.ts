import { OIM_CONNECTION_ID_ARGUMENT } from "@tulipfarm/integrations";
import type { ToolDispatchPlan } from "@tulipfarm/run-kernel";
import type { RuntimeBundle } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { InternalApiClient } from "./client";
import { HttpRoutineOimHost } from "./routine-oim-host";

const plan: ToolDispatchPlan = {
  toolRef: { name: "oim:weather:forecast", version: "1.0.0" },
  action: "integration.weather.forecast",
  arguments: { [OIM_CONNECTION_ID_ARGUMENT]: "connection-east", city: "Pune" },
  idempotencyKey: "routine:run-1:GetWeather",
  effectId: "effect-1",
  logicalEffectOrdinal: 0,
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpRoutineOimHost", () => {
  it("keeps the selected Connection out of provider arguments and dispatches through the API", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          kind: "ready",
          adapter: { kind: "native", ref: "oim-http:weather" },
          destination: "https://api.weather.test",
          credentialRef: "secret://connections/east/token",
          connection: {
            connectionId: "connection-east",
            integrationId: "weather",
            credentialSlot: "token",
            principalKind: "user",
            principalId: "user-1",
          },
        })
      )
      .mockResolvedValueOnce(response({ kind: "succeeded", output: { temperature: 24 } }));
    const host = new HttpRoutineOimHost(
      new InternalApiClient({ baseUrl: "http://api", credential: "credential", fetch })
    );

    const prepared = await host.prepare({
      businessId: "business-1",
      runId: "run-1",
      stateKey: "GetWeather",
      plan,
      bundle: {} as RuntimeBundle,
      authorityLayers: [],
    });

    expect(prepared).toMatchObject({
      kind: "ready",
      arguments: { city: "Pune" },
      connection: { connectionId: "connection-east" },
    });
    if (prepared.kind !== "ready") throw new Error("expected ready");
    await expect(
      prepared.adapter.dispatch({
        intent: {
          intentId: "effect-1",
          businessId: "business-1",
          runId: "run-1",
          stateId: "GetWeather",
          toolId: plan.toolRef.name,
          toolVersion: plan.toolRef.version,
          action: plan.action,
          targetRefs: [],
          arguments: prepared.arguments,
          destination: prepared.destination,
          credentialRef: prepared.credentialRef,
          connection: prepared.connection,
          idempotencyKey: plan.idempotencyKey,
        },
        idempotencyKey: plan.idempotencyKey,
        attempt: 2,
      })
    ).resolves.toEqual({ temperature: 24 });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ connectionId: "connection-east" })
    );
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "http://api/api/v1/internal/runs/run-1/routine-states/GetWeather/tool/resolve"
    );
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ attempt: 2 }));
  });
});
