import type { RegisterWaitInput } from "@tulipfarm/run-kernel";
import { describe, expect, it } from "vitest";
import { InternalApiClient } from "../internal/client";
import { HttpRoutineApprovalPort } from "./approval-port";

function port(handler: (url: string, init?: RequestInit) => Response): {
  approvals: HttpRoutineApprovalPort;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof globalThis.fetch;
  return {
    approvals: new HttpRoutineApprovalPort(
      new InternalApiClient({ baseUrl: "http://api:4010", credential: "tfc_a.b", fetch })
    ),
    calls,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const WAIT: RegisterWaitInput = {
  id: "wait-1",
  businessId: "business-1",
  runId: "run-1",
  stateKey: "Fanout#0/Approve",
  kind: "approval",
  aggregation: "first",
  schemaRef: "wait:approval:Approve",
  allowedPrincipals: ["role:finance"],
  expectedSignals: 1,
  quorum: null,
  deadlineAt: "2026-08-02T00:01:00.000Z",
  createdAt: "2026-08-02T00:00:00.000Z",
};

const OPEN = {
  businessId: "business-1",
  runId: "run-1",
  stateKey: "Fanout#0/Approve",
  stateName: "Approve",
  wait: WAIT,
};

describe("HttpRoutineApprovalPort", () => {
  it("sends the wait plan without the identity the Run itself states", async () => {
    const { approvals, calls } = port(() =>
      json({ approvalId: "wait-1", waitId: "wait-1", decision: "pending" })
    );

    await expect(approvals.open(OPEN)).resolves.toEqual({
      approvalId: "wait-1",
      waitId: "wait-1",
      decision: "pending",
    });
    expect(calls[0]?.url).toBe("http://api:4010/api/v1/internal/runs/run-1/routine-approvals");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      stateKey: "Fanout#0/Approve",
      stateName: "Approve",
      wait: {
        id: "wait-1",
        stateKey: "Fanout#0/Approve",
        kind: "approval",
        aggregation: "first",
        schemaRef: "wait:approval:Approve",
        allowedPrincipals: ["role:finance"],
        expectedSignals: 1,
        quorum: null,
        deadlineAt: "2026-08-02T00:01:00.000Z",
        createdAt: "2026-08-02T00:00:00.000Z",
      },
    });
  });

  it("asks for this State occurrence's decision by its durable key", async () => {
    const { approvals, calls } = port(() =>
      json({ approvalId: "wait-1", waitId: "wait-1", decision: "approved" })
    );

    await expect(
      approvals.find({ businessId: "business-1", runId: "run-1", stateKey: "Fanout#0/Approve" })
    ).resolves.toMatchObject({ decision: "approved" });
    expect(calls[0]?.url).toBe(
      "http://api:4010/api/v1/internal/runs/run-1/routine-approvals?stateKey=Fanout%230%2FApprove"
    );
  });

  it("reads `204` as no approval open, and anything else as the fault it is", async () => {
    const absent = port(() => new Response(null, { status: 204 }));
    await expect(
      absent.approvals.find({ businessId: "business-1", runId: "run-1", stateKey: "Approve" })
    ).resolves.toBeUndefined();

    // A Run that is gone must stay an error: read as "no decision yet" it would park forever.
    const missing = port(() => json({ error: "gone" }, 404));
    await expect(
      missing.approvals.find({ businessId: "business-1", runId: "run-1", stateKey: "Approve" })
    ).rejects.toMatchObject({ status: 404 });
  });
});
