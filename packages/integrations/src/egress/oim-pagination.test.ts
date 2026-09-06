import type { OimPagination } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OIM_PAGINATION_BOUNDS,
  decodePageToken,
  newProgress,
  nextPageToken,
  OimPaginationError,
  parseNextLink,
  recordPage,
  resumeFromToken,
} from "./oim-pagination";

const TOOL = "jira__search_issues";
const BASE = "https://api.example.com";

function context(pagination: OimPagination, currentToken?: string) {
  return {
    toolId: TOOL,
    pagination,
    baseUrl: BASE,
    ...(currentToken === undefined ? {} : { currentToken }),
  };
}

const cursor: OimPagination = {
  type: "cursor",
  requestParameter: "startAt",
  responsePath: "/nextCursor",
};

describe("cursor and continuation pagination", () => {
  it("hides the provider cursor behind an opaque token and resumes with it", () => {
    const token = nextPageToken(context(cursor), { nextCursor: "abc123" }, {});

    expect(token).toBeDefined();
    expect(token).not.toContain("abc123");
    expect(resumeFromToken(context(cursor), token as string)).toEqual({
      parameter: "startAt",
      value: "abc123",
    });
  });

  it("stops when the provider omits or empties the cursor", () => {
    expect(nextPageToken(context(cursor), { nextCursor: "" }, {})).toBeUndefined();
    expect(nextPageToken(context(cursor), {}, {})).toBeUndefined();
  });

  it("refuses a token minted for another operation", () => {
    const token = nextPageToken(context(cursor), { nextCursor: "abc" }, {}) as string;

    expect(() => decodePageToken(token, "slack__list_channels")).toThrow(OimPaginationError);
  });

  it("refuses a token minted for another pagination style", () => {
    const token = nextPageToken(context(cursor), { nextCursor: "abc" }, {}) as string;
    const page: OimPagination = { type: "page", requestParameter: "page" };

    expect(() => resumeFromToken(context(page), token)).toThrow(OimPaginationError);
  });

  it("refuses a token that is not a valid encoded payload", () => {
    expect(() => decodePageToken("not-a-token", TOOL)).toThrow(OimPaginationError);
  });
});

describe("page-number pagination", () => {
  const page: OimPagination = { type: "page", requestParameter: "page", itemsPath: "/values" };

  it("advances while pages hold items and stops on the first empty page", () => {
    const first = nextPageToken(context(page), { values: [1, 2] }, {}) as string;

    expect(resumeFromToken(context(page), first)).toEqual({ parameter: "page", value: "2" });
    expect(nextPageToken(context(page, first), { values: [] }, {})).toBeUndefined();
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

  it("ignores a next link that points off the operation's origin", () => {
    const headers = { link: '<https://evil.example.net/steal>; rel="next"' };

    expect(nextPageToken(context(link), {}, headers)).toBeUndefined();
  });

  it("re-checks the origin on resume so a rewritten token cannot retarget the credential", () => {
    const forged = Buffer.from(
      JSON.stringify({ v: 1, t: TOOL, k: "link", c: "https://evil.example.net/steal" }),
      "utf8"
    ).toString("base64url");

    expect(() => resumeFromToken(context(link), forged)).toThrow(OimPaginationError);
  });

  it("follows a same-origin next link", () => {
    const headers = { link: `<${BASE}/issues?page=2>; rel="next"` };
    const token = nextPageToken(context(link), {}, headers) as string;

    expect(resumeFromToken(context(link), token)).toEqual({ url: `${BASE}/issues?page=2` });
  });
});

describe("bounds", () => {
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
