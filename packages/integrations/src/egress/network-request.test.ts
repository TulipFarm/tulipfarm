import { describe, expect, it, vi } from "vitest";
import type { IntegrationHttpResponse } from "../http";
import {
  classifyGraphqlOperation,
  readableWebContent,
  sendGovernedRequest,
} from "./network-request";
import type { EgressHttpRequest } from "./openapi-adapter";

describe("classifyGraphqlOperation", () => {
  it("classifies the selected operation structurally", () => {
    const document = `
      # mutation Fake
      query ReadIssue { issue { title(note: "mutation StillFake") } }
      mutation CloseIssue { closeIssue }
    `;
    expect(classifyGraphqlOperation(document, "ReadIssue")).toBe("query");
    expect(classifyGraphqlOperation(document, "CloseIssue")).toBe("mutation");
  });

  it("requires a selection when a document has multiple operations", () => {
    expect(() => classifyGraphqlOperation("query A { a } query B { b }")).toThrow(
      "operationName is required"
    );
  });

  it("recognizes shorthand queries and subscriptions", () => {
    expect(classifyGraphqlOperation("{ viewer { id } }")).toBe("query");
    expect(classifyGraphqlOperation("subscription Feed { event }")).toBe("subscription");
  });
});

describe("sendGovernedRequest", () => {
  const response = (
    status: number,
    headers: Record<string, string> = {}
  ): IntegrationHttpResponse => ({
    status,
    headers,
    body: "ok",
  });

  it("follows same-origin redirects and re-sends through the guarded port", async () => {
    const sent: EgressHttpRequest[] = [];
    const http = {
      send: vi.fn(async (request: EgressHttpRequest) => {
        sent.push(request);
        return sent.length === 1 ? response(302, { location: "/next" }) : response(200);
      }),
    };

    await expect(
      sendGovernedRequest(http, { url: "https://example.com/start", method: "GET" })
    ).resolves.toMatchObject({ kind: "response", url: "https://example.com/next" });
    expect(sent.map((request) => request.url)).toEqual([
      "https://example.com/start",
      "https://example.com/next",
    ]);
  });

  it("returns a cross-origin redirect without sending credentials to it", async () => {
    const http = {
      send: vi.fn(async () => response(307, { location: "https://other.example/path" })),
    };
    await expect(
      sendGovernedRequest(http, {
        url: "https://example.com/start",
        method: "GET",
        headers: { authorization: "Bearer hidden" },
      })
    ).resolves.toEqual({
      kind: "cross_origin_redirect",
      from: "https://example.com",
      to: "https://other.example/path",
      status: 307,
    });
    expect(http.send).toHaveBeenCalledTimes(1);
  });
});

it("returns a string for a response that carried no body", () => {
  expect(readableWebContent(undefined, undefined)).toBe("");
});

it("removes executable HTML while preserving readable content", () => {
  expect(
    readableWebContent(
      "text/html",
      "<h1>Title</h1><script>steal()</script><p>Hello &amp; welcome</p>"
    )
  ).toBe("Title\n Hello & welcome");
});
