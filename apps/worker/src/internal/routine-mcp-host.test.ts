import type { McpExecutionBinding } from "@tulipfarm/schema";
import { normalizeToolIntent, type RoutineToolRequest } from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import { InternalApiClient } from "./client";
import { HttpRoutineMcpHost } from "./routine-mcp-host";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const EFFECT_ID = "22222222-2222-4222-8222-222222222222";
const BINDING: McpExecutionBinding = {
  serverId: "github",
  serverRevision: "a".repeat(64),
  accountId: "account-1",
  accountRevision: "1",
  subjectId: "user-1",
  authorizationId: "routine-grant-1",
};

function request(): RoutineToolRequest {
  return {
    businessId: "business-1",
    runId: RUN_ID,
    stateKey: "Send",
    claim: { leaseOwner: "worker-1", leaseGeneration: 3 },
    plan: {
      toolRef: { name: "mcp_github_create_issue", version: BINDING.serverRevision },
      action: "integration.execute",
      arguments: { title: "hello", accountId: "provider-argument-not-authority" },
      idempotencyKey: `routine:${RUN_ID}:Send`,
      effectId: EFFECT_ID,
      logicalEffectOrdinal: 1,
    },
    requesterPrincipalId: "user:user-1",
    bundle: { digest: "b".repeat(64), definitions: [] },
    authorityLayers: [],
  };
}

function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const host = new HttpRoutineMcpHost(
    new InternalApiClient({
      baseUrl: "https://api.example.test",
      credential: "test-only-credential",
      fetch,
    })
  );
  return { fetch, host };
}

function ready() {
  return Response.json({
    kind: "ready",
    adapter: { kind: "mcp", ref: "github" },
    destination: "https://api.githubcopilot.com/mcp/",
    mcp: BINDING,
  });
}

function intent() {
  const input = request();
  return normalizeToolIntent({
    intentId: EFFECT_ID,
    businessId: input.businessId,
    runId: RUN_ID,
    stateId: input.stateKey,
    toolId: input.plan.toolRef.name,
    toolVersion: input.plan.toolRef.version,
    action: input.plan.action,
    arguments: input.plan.arguments,
    targetRefs: [],
    idempotencyKey: input.plan.idempotencyKey,
    mcp: BINDING,
  });
}

describe("HttpRoutineMcpHost", () => {
  it("leaves provider arguments intact and accepts account authority only from the API", async () => {
    const { fetch, host } = fixture();
    fetch.mockResolvedValue(ready());
    await expect(host.prepare(request())).resolves.toMatchObject({
      kind: "ready",
      arguments: request().plan.arguments,
      adapterRef: "github",
      mcp: BINDING,
    });
    expect(fetch).toHaveBeenCalledWith(
      `https://api.example.test/api/v1/internal/runs/${RUN_ID}/routine-states/Send/tool/resolve`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          arguments: request().plan.arguments,
          claim: request().claim,
        }),
      })
    );
  });

  it("preserves a previously approved binding when resolving a resumed effect", async () => {
    const { fetch, host } = fixture();
    fetch.mockResolvedValue(ready());
    await host.prepare(request(), intent());
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          arguments: request().plan.arguments,
          claim: request().claim,
          binding: BINDING,
        }),
      })
    );
  });

  it("dispatches only the claimed effect and receives no plaintext credentials", async () => {
    const { fetch, host } = fixture();
    fetch
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce(Response.json({ kind: "succeeded", output: { issueId: "issue-1" } }));
    const prepared = await host.prepare(request());
    if (prepared.kind !== "ready") throw new Error("expected ready preparation");
    await expect(
      prepared.adapter.dispatch({
        intent: intent(),
        idempotencyKey: request().plan.idempotencyKey,
        attempt: 2,
        timeoutMs: 5_000,
      })
    ).resolves.toEqual({ issueId: "issue-1" });
    expect(fetch).toHaveBeenLastCalledWith(
      `https://api.example.test/api/v1/internal/runs/${RUN_ID}/routine-tools/${EFFECT_ID}/dispatch`,
      expect.objectContaining({
        body: JSON.stringify({ attempt: 2, claim: request().claim }),
      })
    );
    expect(prepared).not.toHaveProperty("credentialRef");
  });

  it("reauthorizes the exact binding before cached output can be replayed", async () => {
    const { fetch, host } = fixture();
    fetch.mockResolvedValue(Response.json({ kind: "failed", reason: "account_access_denied" }));
    await expect(host.revalidate(request(), BINDING)).resolves.toEqual({
      kind: "failed",
      reason: "account_access_denied",
    });
    expect(fetch).toHaveBeenCalledWith(
      `https://api.example.test/api/v1/internal/runs/${RUN_ID}/routine-states/Send/tool/reauthorize`,
      expect.objectContaining({
        body: JSON.stringify({ binding: BINDING, claim: request().claim }),
      })
    );
  });
});
