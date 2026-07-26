import { describe, expect, it, vi } from "vitest";
import {
  OutboundHttpAdapter,
  type OutboundHttpDependencies,
  OutboundHttpError,
  type OutboundHttpTransport,
  renderOutboundHttpTemplate,
} from "./http";

const REQUEST = {
  integrationId: "integration-1",
  destination: "https://hooks.example.com/v1/events",
  method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: { message: "hello" },
  idempotencyKey: "effect-1",
  responseSchema: { type: "object" },
};

function dependencies(transport?: OutboundHttpTransport): OutboundHttpDependencies {
  return {
    transport:
      transport ??
      ({
        send: vi.fn(async () => ({
          status: 200,
          headers: {},
          body: { ok: true },
        })),
      } satisfies OutboundHttpTransport),
    resolve: vi.fn(async () => ["203.0.113.10"]),
    inspectDlp: vi.fn(async () => true),
    validateResponse: vi.fn(() => true),
    ledger: {
      begin: vi.fn(async () => ({ outcome: "started" as const })),
      complete: vi.fn(async (_key, result) => result),
      ambiguous: vi.fn(async () => undefined),
    },
  };
}

const CONFIG = {
  allowedDestinations: ["https://hooks.example.com"],
  maximumRedirects: 2,
  timeoutMs: 1_000,
};

describe("generic outbound HTTP adapter", () => {
  it("renders data-only delivery templates without evaluating expressions", () => {
    expect(
      renderOutboundHttpTemplate(
        { text: "Invoice {{invoiceId}} paid", nested: ["{{amount}}", "{{missing}}"] },
        { invoiceId: "inv-1", amount: 42 }
      )
    ).toEqual({
      text: "Invoice inv-1 paid",
      nested: ["42", ""],
    });
  });

  it("enforces allowlist, DLP, public DNS, response schema, and stable idempotency", async () => {
    const deps = dependencies();
    const adapter = new OutboundHttpAdapter(CONFIG, deps);

    await expect(adapter.deliver(REQUEST)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(deps.transport.send).toHaveBeenCalledWith(
      expect.objectContaining({
        url: REQUEST.destination,
        headers: expect.objectContaining({ "idempotency-key": "effect-1" }),
      }),
      { approvedAddresses: ["203.0.113.10"], timeoutMs: 1_000 }
    );
    expect(deps.ledger.complete).toHaveBeenCalledTimes(1);
  });

  it("validates every redirect destination and pins a fresh DNS result", async () => {
    const transport = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          status: 307,
          headers: { location: "https://callbacks.example.net/final" },
          body: null,
        })
        .mockResolvedValueOnce({ status: 200, headers: {}, body: { ok: true } }),
    };
    const deps = dependencies(transport);
    vi.mocked(deps.resolve)
      .mockResolvedValueOnce(["203.0.113.10"])
      .mockResolvedValueOnce(["198.51.100.20"]);
    const adapter = new OutboundHttpAdapter(
      {
        ...CONFIG,
        allowedDestinations: ["https://hooks.example.com", "https://callbacks.example.net"],
      },
      deps
    );

    await adapter.deliver(REQUEST);

    expect(transport.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ url: "https://callbacks.example.net/final" }),
      { approvedAddresses: ["198.51.100.20"], timeoutMs: 1_000 }
    );
  });

  it.each([
    { name: "loopback", addresses: ["127.0.0.1"] },
    { name: "private IPv4", addresses: ["10.0.0.8"] },
    { name: "link-local IPv6", addresses: ["fe80::1"] },
  ])("blocks $name destinations before dispatch", async ({ addresses }) => {
    const deps = dependencies();
    vi.mocked(deps.resolve).mockResolvedValue(addresses);
    const adapter = new OutboundHttpAdapter(CONFIG, deps);

    await expect(adapter.deliver(REQUEST)).rejects.toEqual(
      new OutboundHttpError("private_destination", "before_dispatch")
    );
    expect(deps.transport.send).not.toHaveBeenCalled();
  });

  it("blocks a DNS rebinding redirect before the second dispatch", async () => {
    const transport = {
      send: vi.fn(async () => ({
        status: 302,
        headers: { location: REQUEST.destination },
        body: null,
      })),
    };
    const deps = dependencies(transport);
    vi.mocked(deps.resolve)
      .mockResolvedValueOnce(["203.0.113.10"])
      .mockResolvedValueOnce(["127.0.0.1"]);
    const adapter = new OutboundHttpAdapter(CONFIG, deps);

    await expect(adapter.deliver(REQUEST)).rejects.toMatchObject({
      code: "private_destination",
    });
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("returns the durable result for a duplicate without another network call", async () => {
    const deps = dependencies();
    vi.mocked(deps.ledger.begin).mockResolvedValue({
      outcome: "duplicate",
      result: { status: 202, body: { existing: true } },
    });
    const adapter = new OutboundHttpAdapter(CONFIG, deps);

    await expect(adapter.deliver(REQUEST)).resolves.toEqual({
      status: 202,
      body: { existing: true },
    });
    expect(deps.transport.send).not.toHaveBeenCalled();
  });

  it("marks a mutating timeout ambiguous and rejects an invalid response schema", async () => {
    const timeoutDeps = dependencies({
      send: vi.fn(async () => {
        throw new OutboundHttpError("timeout", "after_dispatch");
      }),
    });
    await expect(
      new OutboundHttpAdapter(CONFIG, timeoutDeps).deliver(REQUEST)
    ).rejects.toMatchObject({ code: "timeout", phase: "after_dispatch" });
    expect(timeoutDeps.ledger.ambiguous).toHaveBeenCalledWith("effect-1", "timeout");

    const schemaDeps = dependencies();
    vi.mocked(schemaDeps.validateResponse).mockReturnValue(false);
    await expect(
      new OutboundHttpAdapter(CONFIG, schemaDeps).deliver(REQUEST)
    ).rejects.toMatchObject({ code: "response_schema_mismatch", phase: "after_dispatch" });
  });
});
