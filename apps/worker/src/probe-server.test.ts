import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Queryable } from "./db";
import { probeReadiness, startProbeServer } from "./probe-server";

function stubDatabase(version: number | Error): Queryable {
  return {
    async query() {
      if (version instanceof Error) throw version;
      return { rows: [{ version }] };
    },
  };
}

describe("probeReadiness", () => {
  it("is ok when the database is reachable at the schema floor and the worker is serving", async () => {
    await expect(
      probeReadiness({
        port: 0,
        database: stubDatabase(15),
        requiredSchemaVersion: 15,
        isServing: () => true,
        areConsumersReady: () => true,
      })
    ).resolves.toEqual({ status: "ok" });
  });

  it("reports draining before the drain finishes, so routing stops first", async () => {
    await expect(
      probeReadiness({
        port: 0,
        database: stubDatabase(15),
        requiredSchemaVersion: 15,
        isServing: () => false,
        areConsumersReady: () => true,
      })
    ).resolves.toEqual({ status: "down", detail: "draining" });
  });

  it("reports down with the cause when the datastore falls behind the floor", async () => {
    const result = await probeReadiness({
      port: 0,
      database: stubDatabase(14),
      requiredSchemaVersion: 15,
      isServing: () => true,
      areConsumersReady: () => true,
    });
    expect(result.status).toBe("down");
    expect(result.detail).toContain("schema_version is 14");
  });

  it("reports down rather than throwing when the datastore is unreachable", async () => {
    const result = await probeReadiness({
      port: 0,
      database: stubDatabase(new Error("ECONNREFUSED")),
      requiredSchemaVersion: 15,
      isServing: () => true,
      areConsumersReady: () => true,
    });
    expect(result.status).toBe("down");
    expect(result.detail).toContain("cannot read schema_version");
  });

  it("reports down until required consumers are attached", async () => {
    await expect(
      probeReadiness({
        port: 0,
        database: stubDatabase(15),
        requiredSchemaVersion: 15,
        isServing: () => true,
        areConsumersReady: () => false,
      })
    ).resolves.toEqual({ status: "down", detail: "required consumers are not attached" });
  });
});

describe("startProbeServer", () => {
  const servers: { close(cb: () => void): void }[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    );
  });

  async function listen(options: {
    database: Queryable;
    isServing: () => boolean;
    areConsumersReady?: () => boolean;
  }): Promise<string> {
    const server = await startProbeServer({
      port: 0,
      requiredSchemaVersion: 15,
      database: options.database,
      isServing: options.isServing,
      areConsumersReady: options.areConsumersReady ?? (() => true),
    });
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("serves liveness without touching the datastore", async () => {
    const base = await listen({
      database: stubDatabase(new Error("ECONNREFUSED")),
      isServing: () => true,
    });

    const response = await fetch(`${base}/livez`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("serves 200 on readiness when the dependencies are healthy", async () => {
    const base = await listen({ database: stubDatabase(15), isServing: () => true });

    const response = await fetch(`${base}/readyz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("serves 503 on readiness while draining", async () => {
    const base = await listen({ database: stubDatabase(15), isServing: () => false });

    const response = await fetch(`${base}/readyz`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "down", detail: "draining" });
  });

  it("serves 503 until required consumers are attached", async () => {
    const base = await listen({
      database: stubDatabase(15),
      isServing: () => true,
      areConsumersReady: () => false,
    });

    const response = await fetch(`${base}/readyz`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "down",
      detail: "required consumers are not attached",
    });
  });

  it("404s anything that is not a probe", async () => {
    const base = await listen({ database: stubDatabase(15), isServing: () => true });

    const response = await fetch(`${base}/runs`);

    expect(response.status).toBe(404);
  });
});
