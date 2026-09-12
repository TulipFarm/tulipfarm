import type { OimPagination } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { createOimFixturePaginationRuntime } from "./oim-fixture-codec";
import {
  DEFAULT_OIM_PAGINATION_BOUNDS,
  nextPageToken,
  OimPaginationError,
  prepareOimPagination,
} from "./oim-pagination";

const TOOL = "oim.atlassian.v1.list_pages";
const BASE = "https://tenant.atlassian.net/wiki/api/v2";
const cursor: OimPagination = {
  type: "cursor",
  requestParameter: "cursor",
  responsePath: "/nextCursor",
  itemsPath: "/results",
};

function context(pagination: OimPagination = cursor, scope = "compiled-scope") {
  return {
    toolId: TOOL,
    scope,
    pagination,
    baseUrl: BASE,
  };
}

describe("secure OIM continuation state", () => {
  it("keeps secret-shaped provider cursors out of opaque continuation tokens", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    const session = await prepareOimPagination(context(), undefined, runtime);

    const token = await nextPageToken(
      context(),
      session,
      { results: [{ id: "1" }], nextCursor: "secret-provider-cursor" },
      {},
      runtime
    );

    expect(token).toBeDefined();
    expect(token).not.toContain("secret-provider-cursor");
    await expect(prepareOimPagination(context(), token, runtime)).resolves.toMatchObject({
      resume: { parameter: "cursor", value: "secret-provider-cursor" },
      progress: { pages: 1, items: 1, startedAt: 1_000 },
    });
  });

  it("rejects token tampering and unsigned counter-reset payloads", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    const session = await prepareOimPagination(context(), undefined, runtime);
    const token = await nextPageToken(
      context(),
      session,
      { results: [{ id: "1" }], nextCursor: "page-2" },
      {},
      runtime
    );
    const reset = Buffer.from(
      JSON.stringify({
        version: 3,
        toolId: TOOL,
        scope: "compiled-scope",
        style: "cursor",
        cursor: "page-999",
        progress: { pages: 0, items: 0, bytes: 0, startedAtMs: 1_000 },
      })
    ).toString("base64url");

    await expect(prepareOimPagination(context(), `${token}-tampered`, runtime)).rejects.toEqual(
      new OimPaginationError("invalid_page_token")
    );
    await expect(prepareOimPagination(context(), reset, runtime)).rejects.toEqual(
      new OimPaginationError("invalid_page_token")
    );
  });

  it("binds state to the operation, compiled configuration, and caller identity scope", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    const session = await prepareOimPagination(context(), undefined, runtime);
    const token = await nextPageToken(
      context(),
      session,
      { results: [{ id: "1" }], nextCursor: "page-2" },
      {},
      runtime
    );

    await expect(
      prepareOimPagination({ ...context(), toolId: "oim.atlassian.v1.other" }, token, runtime)
    ).rejects.toEqual(new OimPaginationError("invalid_page_token"));
    await expect(
      prepareOimPagination(context(cursor, "other-scope"), token, runtime)
    ).rejects.toEqual(new OimPaginationError("invalid_page_token"));
  });

  it("rejects expired continuation state before it can resume", async () => {
    let now = 1_000;
    const runtime = createOimFixturePaginationRuntime(() => now);
    const session = await prepareOimPagination(context(), undefined, runtime);
    const token = await nextPageToken(
      context(),
      session,
      { results: [{ id: "1" }], nextCursor: "page-2" },
      {},
      runtime
    );
    now += DEFAULT_OIM_PAGINATION_BOUNDS.maxDurationMs;

    await expect(prepareOimPagination(context(), token, runtime)).rejects.toEqual(
      new OimPaginationError("pagination_bound_exceeded")
    );
  });

  it("allows replay within the lifetime without resetting aggregate page counters", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    const bounded = {
      ...context(),
      bounds: { ...DEFAULT_OIM_PAGINATION_BOUNDS, maxPages: 2 },
    };
    const first = await prepareOimPagination(bounded, undefined, runtime);
    const token = await nextPageToken(
      bounded,
      first,
      { results: [{ id: "1" }], nextCursor: "page-2" },
      {},
      runtime
    );
    const firstReplay = await prepareOimPagination(bounded, token, runtime);
    const secondReplay = await prepareOimPagination(bounded, token, runtime);

    await expect(
      nextPageToken(
        bounded,
        firstReplay,
        { results: [{ id: "2" }], nextCursor: "page-3" },
        {},
        runtime
      )
    ).resolves.toBeUndefined();
    await expect(
      nextPageToken(
        bounded,
        secondReplay,
        { results: [{ id: "2" }], nextCursor: "page-3" },
        {},
        runtime
      )
    ).resolves.toBeUndefined();
  });

  it("stops exactly at aggregate item, byte, and duration bounds", async () => {
    let now = 1_000;
    const runtime = createOimFixturePaginationRuntime(() => now);
    const itemBounded = {
      ...context(),
      bounds: { ...DEFAULT_OIM_PAGINATION_BOUNDS, maxItems: 1 },
    };
    await expect(
      nextPageToken(
        itemBounded,
        await prepareOimPagination(itemBounded, undefined, runtime),
        { results: [{ id: "1" }], nextCursor: "page-2" },
        {},
        runtime
      )
    ).resolves.toBeUndefined();

    const body = { results: [], nextCursor: "page-2" };
    const byteBounded = {
      ...context(),
      bounds: {
        ...DEFAULT_OIM_PAGINATION_BOUNDS,
        maxBytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
      },
    };
    await expect(
      nextPageToken(
        byteBounded,
        await prepareOimPagination(byteBounded, undefined, runtime),
        body,
        {},
        runtime
      )
    ).resolves.toBeUndefined();

    const durationBounded = context();
    const durationSession = await prepareOimPagination(durationBounded, undefined, runtime);
    now += DEFAULT_OIM_PAGINATION_BOUNDS.maxDurationMs;
    await expect(
      nextPageToken(
        durationBounded,
        durationSession,
        { results: [], nextCursor: "page-2" },
        {},
        runtime
      )
    ).resolves.toBeUndefined();
  });
});
