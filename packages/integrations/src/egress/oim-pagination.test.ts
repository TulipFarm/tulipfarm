import type { OimPagination } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { createOimFixturePaginationRuntime } from "./oim-fixture-codec";
import {
  DEFAULT_OIM_PAGINATION_BOUNDS,
  newProgress,
  nextPageToken,
  OimPaginationError,
  parseNextLink,
  prepareOimPagination,
  recordPage,
} from "./oim-pagination";

const TOOL = "jira__search_issues";
const BASE = "https://api.example.com";

function context(pagination: OimPagination, scope = "scope-1") {
  return {
    toolId: TOOL,
    scope,
    pagination,
    baseUrl: BASE,
  };
}

const cursor: OimPagination = {
  type: "cursor",
  requestParameter: "startAt",
  responsePath: "/nextCursor",
};

describe("cursor and continuation pagination", () => {
  it("hides the provider cursor behind an opaque token and resumes with it", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    const session = await prepareOimPagination(context(cursor), undefined, runtime);
    const token = await nextPageToken(
      context(cursor),
      session,
      { nextCursor: "abc123" },
      {},
      runtime
    );

    expect(token).toBeDefined();
    expect(token).not.toContain("abc123");
    await expect(prepareOimPagination(context(cursor), token, runtime)).resolves.toMatchObject({
      resume: { parameter: "startAt", value: "abc123" },
    });
  });

  it("stops when the provider omits or empties the cursor", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    await expect(
      nextPageToken(
        context(cursor),
        await prepareOimPagination(context(cursor), undefined, runtime),
        { nextCursor: "" },
        {},
        runtime
      )
    ).resolves.toBeUndefined();
    await expect(
      nextPageToken(
        context(cursor),
        await prepareOimPagination(context(cursor), undefined, runtime),
        {},
        {},
        runtime
      )
    ).resolves.toBeUndefined();
  });

  it("refuses a token minted for another operation", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    const token = await nextPageToken(
      context(cursor),
      await prepareOimPagination(context(cursor), undefined, runtime),
      { nextCursor: "abc" },
      {},
      runtime
    );

    await expect(
      prepareOimPagination({ ...context(cursor), toolId: "slack__list_channels" }, token, runtime)
    ).rejects.toThrow(OimPaginationError);
  });

  it("refuses a token minted for another pagination style", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    const token = await nextPageToken(
      context(cursor),
      await prepareOimPagination(context(cursor), undefined, runtime),
      { nextCursor: "abc" },
      {},
      runtime
    );
    const page: OimPagination = { type: "page", requestParameter: "page" };

    await expect(prepareOimPagination(context(page), token, runtime)).rejects.toThrow(
      OimPaginationError
    );
  });

  it("refuses a token minted for another configuration or identity scope", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    const token = await nextPageToken(
      context(cursor),
      await prepareOimPagination(context(cursor), undefined, runtime),
      { nextCursor: "abc" },
      {},
      runtime
    );

    await expect(prepareOimPagination(context(cursor, "scope-2"), token, runtime)).rejects.toThrow(
      OimPaginationError
    );
  });

  it("refuses oversized provider continuation data", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    await expect(
      nextPageToken(
        context(cursor),
        await prepareOimPagination(context(cursor), undefined, runtime),
        { nextCursor: "x".repeat(4097) },
        {},
        runtime
      )
    ).resolves.toBeUndefined();
  });

  it("refuses a token that the host codec did not issue", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    await expect(prepareOimPagination(context(cursor), "not-a-token", runtime)).rejects.toThrow(
      OimPaginationError
    );
  });
});

describe("page-number pagination", () => {
  const page: OimPagination = { type: "page", requestParameter: "page", itemsPath: "/values" };

  it("advances while pages hold items and stops on the first empty page", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    const first = await nextPageToken(
      context(page),
      await prepareOimPagination(context(page), undefined, runtime),
      { values: [1, 2] },
      {},
      runtime
    );
    const resumed = await prepareOimPagination(context(page), first, runtime);

    expect(resumed.resume).toEqual({ parameter: "page", value: "2" });
    await expect(
      nextPageToken(context(page), resumed, { values: [] }, {}, runtime)
    ).resolves.toBeUndefined();
  });
});

describe("link pagination", () => {
  const link: OimPagination = { type: "link" };

  it("extracts only the rel=next target", () => {
    expect(parseNextLink('<https://a/1>; rel="prev", <https://a/3>; rel="next"')).toBe(
      "https://a/3"
    );
    expect(parseNextLink('<https://a/1>; rel="prev"')).toBeUndefined();
    expect(parseNextLink(undefined)).toBeUndefined();
  });

  it("ignores a next link that points off the operation's origin", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    const headers = { link: '<https://evil.example.net/steal>; rel="next"' };

    await expect(
      nextPageToken(
        context(link),
        await prepareOimPagination(context(link), undefined, runtime),
        {},
        headers,
        runtime
      )
    ).resolves.toBeUndefined();
  });

  it("rejects a rewritten token before it can retarget the credential", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    await expect(
      prepareOimPagination(context(link), "forged-off-origin-token", runtime)
    ).rejects.toThrow(OimPaginationError);
  });

  it("follows a same-origin next link", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    const headers = { link: `<${BASE}/issues?page=2>; rel="next"` };
    const token = await nextPageToken(
      context(link),
      await prepareOimPagination(context(link), undefined, runtime),
      {},
      headers,
      runtime
    );

    await expect(prepareOimPagination(context(link), token, runtime)).resolves.toMatchObject({
      resume: { url: `${BASE}/issues?page=2` },
    });
  });

  it("resolves a relative next link against the operation base URL", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    const headers = {
      link: '</wiki/api/v2/pages?cursor=abc%2F123&limit=25>; rel="next"',
    };
    const token = await nextPageToken(
      context(link),
      await prepareOimPagination(context(link), undefined, runtime),
      {},
      headers,
      runtime
    );

    await expect(prepareOimPagination(context(link), token, runtime)).resolves.toMatchObject({
      resume: { url: `${BASE}/wiki/api/v2/pages?cursor=abc%2F123&limit=25` },
    });
  });
});

describe("bounds", () => {
  it("carries aggregate page limits across continuation tokens", async () => {
    const runtime = createOimFixturePaginationRuntime(() => 1_000);
    const bounds = { ...DEFAULT_OIM_PAGINATION_BOUNDS, maxPages: 2 };
    const bounded = { ...context(cursor), bounds };
    const first = await nextPageToken(
      bounded,
      await prepareOimPagination(bounded, undefined, runtime),
      { values: [1], nextCursor: "page-2" },
      {},
      runtime
    );

    const resumed = await prepareOimPagination(bounded, first, runtime);
    await expect(
      nextPageToken(bounded, resumed, { values: [2], nextCursor: "page-3" }, {}, runtime)
    ).resolves.toBeUndefined();
  });

  it("keeps the page it fetched and reports that iteration must stop", () => {
    const progress = newProgress(0);
    const bounds = { ...DEFAULT_OIM_PAGINATION_BOUNDS, maxItems: 2 };

    expect(recordPage(progress, { values: [1, 2] }, "/values", bounds, 0)).toBe(false);
    expect(progress.items).toBe(2);
    expect(progress.pages).toBe(1);
  });

  it("stops on elapsed time even when nothing else is exhausted", () => {
    const progress = newProgress(0);

    expect(
      recordPage(progress, { values: [] }, "/values", DEFAULT_OIM_PAGINATION_BOUNDS, 90_000)
    ).toBe(false);
  });

  it("allows another page while every bound has room", () => {
    const progress = newProgress(0);

    expect(
      recordPage(progress, { values: [1] }, "/values", DEFAULT_OIM_PAGINATION_BOUNDS, 10)
    ).toBe(true);
  });
});
