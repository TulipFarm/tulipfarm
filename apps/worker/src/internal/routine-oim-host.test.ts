import type { AuthorityLayer } from "@tulipfarm/authz";
import type { ToolDispatchPlan } from "@tulipfarm/run-kernel";
import type { RuntimeBundle } from "@tulipfarm/soul";
import type { ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import type { RoutineToolRequest } from "../routine/tool-port";
import type { InternalApiClient } from "./client";
import { HttpRoutineOimHost } from "./routine-oim-host";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const EFFECT_ID = "22222222-2222-4222-8222-222222222222";

function request(): RoutineToolRequest {
  const plan: ToolDispatchPlan = {
    toolRef: { name: "oim.acme.v2.send_message", version: "2.0.0" },
    action: "message.send",
    arguments: {
      connection_id: "connection-1",
      body: { text: "hello" },
    },
    idempotencyKey: `routine:${RUN_ID}:Send`,
    effectId: EFFECT_ID,
    logicalEffectOrdinal: 1,
  };
  return {
    businessId: "business-1",
    runId: RUN_ID,
    stateKey: "Send",
    claim: { leaseOwner: "worker-1", leaseGeneration: 3 },
    plan,
    requesterPrincipalId: "user:user-1",
    bundle: { digest: "b".repeat(64) } as RuntimeBundle,
    authorityLayers: [] as AuthorityLayer[],
  };
}

describe("HttpRoutineOimHost", () => {
  it("keeps the Connection selector out of provider arguments and returns exact host bindings", async () => {
    const require = vi.fn(async () => ({
      kind: "ready" as const,
      adapter: { kind: "native" as const, ref: "oim-acme" },
      destination: "https://api.acme.test",
      filePrincipalId: "user-1",
      fileIds: ["file-1"],
      integrationId: "acme",
      integrationMajorVersion: 2,
      operationId: "send_message",
      manifestDigest: "m".repeat(64),
      configurationDigest: "c".repeat(64),
    }));
    const host = new HttpRoutineOimHost({ require } as unknown as InternalApiClient);

    await expect(host.prepare(request())).resolves.toMatchObject({
      kind: "ready",
      arguments: { body: { text: "hello" } },
      adapterRef: "oim-acme",
      destination: "https://api.acme.test",
      fileIds: ["file-1"],
      integrationId: "acme",
      operationId: "send_message",
    });
    expect(require).toHaveBeenCalledWith(
      "POST",
      `/api/v1/internal/runs/${RUN_ID}/routine-states/Send/tool/resolve`,
      {
        connectionId: "connection-1",
        arguments: { body: { text: "hello" } },
        claim: { leaseOwner: "worker-1", leaseGeneration: 3 },
      },
      { signal: undefined }
    );
  });

  it("dispatches through the API host without exposing Credentials to the Worker", async () => {
    const require = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "ready",
        adapter: { kind: "native", ref: "oim-acme" },
        integrationId: "acme",
        integrationMajorVersion: 2,
        operationId: "send_message",
        manifestDigest: "m".repeat(64),
        configurationDigest: "c".repeat(64),
      })
      .mockResolvedValueOnce({ kind: "succeeded", output: { messageId: "message-1" } });
    const prepared = await new HttpRoutineOimHost({
      require,
    } as unknown as InternalApiClient).prepare(request());
    if (prepared.kind !== "ready") throw new Error("expected ready preparation");
    const dispatchRequest = {
      intent: {
        intentId: EFFECT_ID,
        runId: RUN_ID,
      },
      idempotencyKey: "idempotency-1",
      attempt: 2,
      timeoutMs: 5_000,
    } as ToolAdapterRequest;

    await expect(prepared.adapter.dispatch(dispatchRequest)).resolves.toEqual({
      messageId: "message-1",
    });
    expect(require).toHaveBeenLastCalledWith(
      "POST",
      `/api/v1/internal/runs/${RUN_ID}/routine-tools/${EFFECT_ID}/dispatch`,
      { attempt: 2, claim: { leaseOwner: "worker-1", leaseGeneration: 3 } },
      { signal: undefined, timeoutMs: 5_000 }
    );
  });
});
