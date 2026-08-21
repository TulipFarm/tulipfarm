import {
  type CuratorHost,
  CuratorHostError,
  type CuratorMinter,
  type CuratorRecovery,
  type CuratorTaskDelivery,
} from "@tulipfarm/curator-host";
import type { CuratorObservedPayload } from "@tulipfarm/storage";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CuratorRouteDeps, registerCuratorRoutes } from "./routes";

const BUSINESS = "business-1";

class FakeHost {
  contextCalls: string[] = [];
  submissions: { jobId: string; digest: string; output: unknown }[] = [];
  throws?: CuratorHostError;

  async context(businessId: string, jobId: string): Promise<Record<string, unknown>> {
    if (this.throws) throw this.throws;
    this.contextCalls.push(`${businessId}/${jobId}`);
    return { jobId, scope: "user", contextDigest: "digest-1", turns: [] };
  }
  async submit(
    _businessId: string,
    jobId: string,
    contextDigest: string,
    output: unknown
  ): Promise<{ recorded: number; rejected: number; scope: "user" | "business" }> {
    if (this.throws) throw this.throws;
    this.submissions.push({ jobId, digest: contextDigest, output });
    return { recorded: 1, rejected: 0, scope: "user" };
  }
}

class FakeMinter {
  calls: string[] = [];

  async mintForUser(businessId: string, userId: string): Promise<unknown> {
    this.calls.push(`user:${businessId}/${userId}`);
    return { outcome: "minted", jobId: "job-1", runId: "run-1" };
  }
  async mintForBusiness(businessId: string): Promise<unknown> {
    this.calls.push(`business:${businessId}`);
    return { outcome: "skipped", reason: "no_work" };
  }
}

class FakeDelivery {
  calls: string[] = [];

  async run(businessId: string) {
    this.calls.push(businessId);
    return { delivered: 1, retryableFailed: 0, terminalRejected: 0 };
  }
}

async function buildServer(
  host: FakeHost,
  principalKind: "service" | "user" | undefined,
  minter: FakeMinter = new FakeMinter(),
  extra: Partial<CuratorRouteDeps> = {},
  delivery: FakeDelivery = new FakeDelivery()
): Promise<FastifyInstance> {
  const app = Fastify();
  registerCuratorRoutes(
    app,
    {
      host: host as unknown as CuratorHost,
      minter: minter as unknown as CuratorMinter,
      recovery: { run: async () => ({ recovered: 1, abandoned: 0 }) } as unknown as CuratorRecovery,
      delivery: delivery as unknown as CuratorTaskDelivery,
      ...extra,
    },
    BUSINESS,
    async (req: { principal?: unknown }) => {
      if (principalKind) {
        req.principal = { kind: principalKind, id: "p-1" };
      }
    }
  );
  await app.ready();
  return app;
}

describe("curator internal routes", () => {
  let host: FakeHost;
  let app: FastifyInstance;

  beforeEach(() => {
    host = new FakeHost();
  });

  afterEach(async () => {
    await app?.close();
  });

  it("serves the pinned context to a service principal", async () => {
    app = await buildServer(host, "service");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/internal/curator/jobs/job-1/context",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ jobId: "job-1", contextDigest: "digest-1" });
    expect(host.contextCalls).toEqual([`${BUSINESS}/job-1`]);
  });

  it.each(["user", undefined] as const)("refuses a %s principal", async (kind) => {
    app = await buildServer(host, kind);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/internal/curator/jobs/job-1/context",
    });
    expect(res.statusCode).toBe(403);
    expect(host.contextCalls).toEqual([]);
  });

  it("delivers pending Proposal Tasks only for a service principal", async () => {
    const delivery = new FakeDelivery();
    app = await buildServer(host, "service", new FakeMinter(), {}, delivery);
    const res = await app.inject({ method: "POST", url: "/api/v1/internal/curator/deliver" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ delivered: 1, retryableFailed: 0, terminalRejected: 0 });
    expect(delivery.calls).toEqual([BUSINESS]);
  });

  it("maps an unknown job to 404", async () => {
    host.throws = new CuratorHostError("job_not_found");
    app = await buildServer(host, "service");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/internal/curator/jobs/job-1/context",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "job_not_found" });
  });

  it("maps a digest mismatch to 422, not a retryable 409", async () => {
    host.throws = new CuratorHostError("digest_mismatch");
    app = await buildServer(host, "service");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/internal/curator/jobs/job-1/effects",
      payload: { contextDigest: "stale", output: {} },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "digest_mismatch" });
  });

  it("passes raw output through untouched", async () => {
    app = await buildServer(host, "service");
    const output = { memory: [{ section: "identity", add: ["x"], citations: [] }] };
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/internal/curator/jobs/job-1/effects",
      payload: { contextDigest: "digest-1", output },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recorded: 1, rejected: 0 });
    expect(host.submissions).toEqual([{ jobId: "job-1", digest: "digest-1", output }]);
  });

  it("strips a Worker-authored effect out of the submission body", async () => {
    app = await buildServer(host, "service");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/internal/curator/jobs/job-1/effects",
      payload: { contextDigest: "digest-1", output: {}, effects: [{ kind: "memory_patch" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(host.submissions).toEqual([{ jobId: "job-1", digest: "digest-1", output: {} }]);
  });

  it("keeps raw model output whole, including keys the body schema does not name", async () => {
    app = await buildServer(host, "service");
    const output = { memory: [], proposals: [], unknownFromANewerModel: { nested: [1, 2] } };
    await app.inject({
      method: "POST",
      url: "/api/v1/internal/curator/jobs/job-1/effects",
      payload: { contextDigest: "digest-1", output },
    });
    expect(host.submissions[0]?.output).toEqual(output);
  });

  it("refuses a submission with no digest to bind it", async () => {
    app = await buildServer(host, "service");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/internal/curator/jobs/job-1/effects",
      payload: { output: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(host.submissions).toEqual([]);
  });

  describe("mint", () => {
    let minter: FakeMinter;

    beforeEach(() => {
      minter = new FakeMinter();
    });

    it("mints for one user", async () => {
      app = await buildServer(host, "service", minter);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/curator/mint",
        payload: { scope: "user", userId: "user-1" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: "minted", jobId: "job-1", runId: "run-1" });
      expect(minter.calls).toEqual([`user:${BUSINESS}/user-1`]);
    });

    it("reports a skip rather than failing when there is nothing to do", async () => {
      app = await buildServer(host, "service", minter);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/curator/mint",
        payload: { scope: "business" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: "skipped", reason: "no_work" });
    });

    it("refuses a user mint with no user", async () => {
      app = await buildServer(host, "service", minter);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/curator/mint",
        payload: { scope: "user" },
      });
      expect(res.statusCode).toBe(400);
      expect(minter.calls).toEqual([]);
    });

    it("strips caller-supplied work ids, so no caller can choose the inputs", async () => {
      app = await buildServer(host, "service", minter);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/curator/mint",
        payload: { scope: "user", userId: "user-1", turnIds: ["turn-9"], candidateIds: ["c-9"] },
      });
      expect(res.statusCode).toBe(200);
      // The target reached the minter and nothing else did: which work the job reasons over is
      // claimed server-side, so a caller cannot point the loop at inputs the target never produced.
      expect(minter.calls).toEqual([`user:${BUSINESS}/user-1`]);
    });

    it("is closed to a user principal", async () => {
      app = await buildServer(host, "user", minter);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/curator/mint",
        payload: { scope: "business" },
      });
      expect(res.statusCode).toBe(403);
      expect(minter.calls).toEqual([]);
    });
  });

  it("reconciles jobs that stopped making progress", async () => {
    app = await buildServer(host, "service");
    const res = await app.inject({ method: "POST", url: "/api/v1/internal/curator/reconcile" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recovered: 1, abandoned: 0 });
  });

  it("is closed to a user principal on reconcile", async () => {
    app = await buildServer(host, "user");
    const res = await app.inject({ method: "POST", url: "/api/v1/internal/curator/reconcile" });
    expect(res.statusCode).toBe(403);
  });

  describe("observability", () => {
    let seen: CuratorObservedPayload[];
    let observe: (p: CuratorObservedPayload) => void;

    beforeEach(() => {
      seen = [];
      observe = (p) => seen.push(p);
    });

    it("reports a mint with its scope, and a skip with the reason it was refused", async () => {
      const minter = new FakeMinter();
      app = await buildServer(host, "service", minter, { observe });

      await app.inject({
        method: "POST",
        url: "/api/v1/internal/curator/mint",
        payload: { scope: "user", userId: "user-1" },
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/internal/curator/mint",
        payload: { scope: "business" },
      });

      expect(seen).toEqual([
        { stage: "mint", scope: "user", outcome: "minted" },
        { stage: "mint", scope: "business", outcome: "skipped", reason: "no_work" },
      ]);
    });

    it("reports settlement effect counts under the job's own scope", async () => {
      app = await buildServer(host, "service", new FakeMinter(), { observe });

      await app.inject({
        method: "POST",
        url: "/api/v1/internal/curator/jobs/job-1/effects",
        payload: { contextDigest: "digest-1", output: {} },
      });

      expect(seen).toEqual([
        { stage: "settle", scope: "user", outcome: "settled", recorded: 1, rejected: 0 },
      ]);
    });

    // The scope of a job that was never found is genuinely unknown, and inventing one would put a
    // wrong label on every not-found series.
    it("reports a denial by its code, with no scope it cannot know", async () => {
      host.throws = new CuratorHostError("job_not_found");
      app = await buildServer(host, "service", new FakeMinter(), { observe });

      await app.inject({
        method: "POST",
        url: "/api/v1/internal/curator/jobs/job-1/effects",
        payload: { contextDigest: "digest-1", output: {} },
      });

      expect(seen).toEqual([{ stage: "denial", outcome: "job_not_found" }]);
    });

    it("carries the mint's scope onto a denial raised while minting", async () => {
      const minter = {
        mintForBusiness: async () => {
          throw new CuratorHostError("already_settled");
        },
      } as unknown as FakeMinter;
      app = await buildServer(host, "service", minter, { observe });

      await app.inject({
        method: "POST",
        url: "/api/v1/internal/curator/mint",
        payload: { scope: "business" },
      });

      expect(seen).toEqual([{ stage: "denial", outcome: "already_settled", scope: "business" }]);
    });

    it("reports repair counts and backlog staleness once per sweep", async () => {
      app = await buildServer(host, "service", new FakeMinter(), {
        observe,
        backlogAgeSeconds: async () => 420,
      });

      await app.inject({ method: "POST", url: "/api/v1/internal/curator/reconcile" });

      expect(seen).toEqual([
        { stage: "recovery", outcome: "recovered", count: 1 },
        { stage: "recovery", outcome: "abandoned", count: 0 },
        { stage: "recovery", outcome: "swept", backlogAgeSeconds: 420 },
      ]);
    });

    // An empty backlog has no age. Reporting zero would read as "perfectly fresh" on a dashboard,
    // which is the opposite of "there was nothing to be fresh about".
    it("reports no staleness when the backlog is empty", async () => {
      app = await buildServer(host, "service", new FakeMinter(), {
        observe,
        backlogAgeSeconds: async () => null,
      });

      await app.inject({ method: "POST", url: "/api/v1/internal/curator/reconcile" });

      expect(seen.some((p) => p.outcome === "swept")).toBe(false);
    });

    // Telemetry is never allowed to decide whether the loop worked.
    it("serves the request when the observer throws", async () => {
      app = await buildServer(host, "service", new FakeMinter(), {
        observe: () => {
          throw new Error("sink exploded");
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/curator/mint",
        payload: { scope: "business" },
      });

      expect(res.statusCode).toBe(200);
    });

    it("serves the reconcile when the backlog read fails", async () => {
      app = await buildServer(host, "service", new FakeMinter(), {
        observe,
        backlogAgeSeconds: async () => {
          throw new Error("database gone");
        },
      });

      const res = await app.inject({ method: "POST", url: "/api/v1/internal/curator/reconcile" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ recovered: 1, abandoned: 0 });
    });

    // The Worker is not entitled to the job's scope; it is read server-side for the metric only.
    it("keeps the settlement scope out of the response body", async () => {
      app = await buildServer(host, "service", new FakeMinter(), { observe });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/internal/curator/jobs/job-1/effects",
        payload: { contextDigest: "digest-1", output: {} },
      });

      expect(res.json()).toEqual({ recorded: 1, rejected: 0 });
    });
  });
});
