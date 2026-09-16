import { createHash } from "node:crypto";
import { PACK_CATALOG_URL } from "@tulipfarm/constants/site";
import { FetchEgressHttp, GuardedEgressHttp } from "@tulipfarm/integrations";
import { PACK_MAX_BYTES, type PackDefinition } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { PackService } from "./service";

const pack: PackDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Pack",
  name: "support",
  version: 1,
  title: "Support",
  description: "Support presets",
  category: "Support",
  artifacts: [
    {
      kind: "resource",
      name: "tickets",
      description: "Tickets",
      template: {
        name: "tickets",
        schema: { type: "object", properties: { title: { type: "string" } } },
      },
    },
  ],
  plan: {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Plan",
    name: "support",
    version: 1,
    steps: [{ id: "Inspect", tool: "list_resource_types" }],
  },
};
const yaml = stringify(pack);

function transport(response: () => Response, addresses = ["93.184.216.34"]) {
  const fetch = vi.fn(async (_input: string, _init: RequestInit) => response());
  const inner = new FetchEgressHttp({ fetch });
  const send = vi.spyOn(inner, "send");
  const resolve = vi.fn(async () => addresses);
  const service = new PackService(new GuardedEgressHttp(inner, { resolve }));
  return { service, fetch, send, resolve };
}

describe("Pack preview", () => {
  it("reads exact raw JSON/YAML bytes, pins DNS, and never follows external template URLs", async () => {
    const source = `\ufeff${JSON.stringify({ ...pack, requirements: ["https://other.example/code"] }, null, 2)}\n`;
    const { service, fetch, send } = transport(() => new Response(source));
    const result = await service.preview({ url: "https://example.com/preset" });
    expect(result.sha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(result.pack.artifacts).toEqual(pack.artifacts);
    expect(result.url).toBe("https://example.com/preset");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        pinnedAddresses: ["93.184.216.34"],
        maxResponseBytes: PACK_MAX_BYTES,
        headers: { accept: expect.any(String) },
      })
    );
  });

  it("accepts pasted YAML without making network calls", async () => {
    const { service, fetch } = transport(() => new Response(yaml));
    expect(await service.preview({ yaml })).toEqual({
      pack,
      sha256: createHash("sha256").update(yaml).digest("hex"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://example.com/pack",
    "https://user:pass@example.com/pack",
    "https://127.0.0.1/pack",
    "https://169.254.169.254/latest",
    "https://[::1]/pack",
    "https://[::ffff:127.0.0.1]/pack",
  ])("refuses unsafe URL %s before transport", async (url) => {
    const { service, fetch } = transport(() => new Response(yaml));
    await expect(service.preview({ url })).rejects.toMatchObject({
      status: 400,
      code: "destination_refused",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a public hostname resolving privately", async () => {
    const { service, fetch } = transport(() => new Response(yaml), ["10.0.0.1"]);
    await expect(service.preview({ url: "https://example.com/pack" })).rejects.toMatchObject({
      code: "destination_refused",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("revalidates every redirect and refuses cross-origin redirects", async () => {
    const { service, fetch } = transport(
      () => new Response("", { status: 302, headers: { location: "https://other.example/pack" } })
    );
    await expect(service.preview({ url: "https://example.com/pack" })).rejects.toMatchObject({
      status: 502,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds redirect loops", async () => {
    const { service, fetch } = transport(
      () => new Response("", { status: 302, headers: { location: "/loop" } })
    );
    await expect(service.preview({ url: "https://example.com/pack" })).rejects.toMatchObject({
      status: 502,
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("constrains Skill destinations, including www redirects", async () => {
    const { service, fetch } = transport(
      () => new Response("", { status: 302, headers: { location: "https://www.example.com/pack" } })
    );
    const assertDestination = vi.fn((origin: string) => {
      if (origin !== "https://example.com") throw new Error("denied");
    });
    await expect(
      service.preview({ url: "https://example.com/pack" }, { assertDestination })
    ).rejects.toMatchObject({ status: 502 });
    expect(assertDestination.mock.calls).toEqual([
      ["https://example.com"],
      ["https://www.example.com"],
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    () => new Response("x".repeat(PACK_MAX_BYTES + 1)),
    () => new Response("small", { headers: { "content-length": String(PACK_MAX_BYTES + 1) } }),
    () => new Response("not accessible", { status: 500 }),
    () => new Response(new Uint8Array([255, 254, 253])),
  ])("rejects an incomplete, oversized or inaccessible source", async (response) => {
    const { service } = transport(response);
    await expect(service.preview({ url: "https://example.com/pack" })).rejects.toMatchObject({
      status: 502,
    });
  });

  it("rejects invalid schema, aliases, duplicate keys, duplicate artifacts and invalid graphs", async () => {
    const service = new PackService();
    for (const source of [
      `${yaml}\nunknown: true`,
      "kind: Pack\nkind: Plan",
      "first: &loop [*loop]",
      `${yaml}\n---\n${yaml}`,
      stringify({ ...pack, artifacts: [...pack.artifacts, ...pack.artifacts] }),
      stringify({
        ...pack,
        plan: { ...pack.plan, steps: [{ id: "Loop", tool: "record_list", needs: ["Loop"] }] },
      }),
      stringify({
        ...pack,
        plan: { ...pack.plan, steps: [{ id: "Read", tool: "record_list", needs: ["Missing"] }] },
      }),
      stringify(pack.plan),
      "é".repeat(PACK_MAX_BYTES),
    ]) {
      await expect(service.preview({ yaml: source })).rejects.toMatchObject({ status: 400 });
    }
  });

  it("carries cancellation to the pinned request", async () => {
    const { service, send } = transport(() => new Response(yaml));
    const controller = new AbortController();
    await service.preview({ url: "https://example.com/pack" }, { signal: controller.signal });
    controller.abort();
    expect(send.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });

  it("bounds an unresolved DNS lookup without waiting for it to finish", async () => {
    const send = vi.fn(async () => ({ status: 200, headers: {}, body: yaml }));
    const service = new PackService(
      new GuardedEgressHttp(
        { send },
        {
          resolve: () => new Promise(() => {}),
        }
      )
    );
    const controller = new AbortController();
    const pending = service.preview(
      { url: "https://example.com/pack" },
      { signal: controller.signal }
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 502 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Pack catalog", () => {
  const entry = {
    name: pack.name,
    title: pack.title,
    description: pack.description,
    category: pack.category,
    version: pack.version,
    url: "https://example.com/support",
  };
  it("fetches only the catalog and only when requested", async () => {
    const { service, fetch } = transport(() => new Response(JSON.stringify({ packs: [entry] })));
    expect(fetch).not.toHaveBeenCalled();
    expect(await service.catalog()).toEqual({ packs: [entry] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(PACK_CATALOG_URL);
  });
  it.each([
    { packs: [{ ...entry, url: "https://127.0.0.1/pack" }] },
    { packs: [entry, entry] },
    { packs: [], extra: true },
  ])("refuses invalid catalog content", async (content) => {
    const { service } = transport(() => new Response(JSON.stringify(content)));
    await expect(service.catalog()).rejects.toMatchObject({ status: 502, code: "invalid_catalog" });
  });
});
