import { describe, expect, it, vi } from "vitest";
import type { IntegrationHttpResponse } from "../http";
import {
  classifyGraphqlOperation,
  normalizedPublicUrl,
  sendGovernedRequest,
} from "./network-request";
import type { EgressHttpPort, EgressHttpRequest } from "./openapi-adapter";

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

describe("normalizedPublicUrl — the http scheme", () => {
  it("upgrades http to https so a pasted link is read rather than refused", () => {
    expect(normalizedPublicUrl("http://example.com/docs").href).toBe("https://example.com/docs");
  });

  it("keeps an explicit port when it swaps the scheme", () => {
    expect(normalizedPublicUrl("http://example.com:8080/docs").href).toBe(
      "https://example.com:8080/docs"
    );
  });

  it("still refuses a scheme that is not http, rather than upgrading it too", () => {
    expect(() => normalizedPublicUrl("ftp://example.com/docs")).toThrow();
  });
});

describe("sendGovernedRequest — the www. label", () => {
  function redirectingTo(location: string): { http: EgressHttpPort; sent: string[] } {
    const sent: string[] = [];
    return {
      sent,
      http: {
        send: async (request) => {
          sent.push(request.url);
          return sent.length === 1
            ? { status: 301, headers: { location } as Record<string, string>, body: "" }
            : { status: 200, headers: { "content-type": "text/html" }, body: "<p>ok</p>" };
        },
      },
    };
  }

  it("follows an apex to www redirect, the most common redirect on the web", async () => {
    const { http, sent } = redirectingTo("https://www.example.com/docs");
    await expect(
      sendGovernedRequest(http, { url: "https://example.com/docs", method: "GET" })
    ).resolves.toMatchObject({ kind: "response", url: "https://www.example.com/docs" });
    expect(sent).toEqual(["https://example.com/docs", "https://www.example.com/docs"]);
  });

  it("follows a www to apex redirect too", async () => {
    const { http } = redirectingTo("https://example.com/docs");
    await expect(
      sendGovernedRequest(http, { url: "https://www.example.com/docs", method: "GET" })
    ).resolves.toMatchObject({ kind: "response", url: "https://example.com/docs" });
  });

  it("upgrades every hop, so a destination cannot answer 301 to strip TLS", async () => {
    const { http, sent } = redirectingTo("http://example.com/plain");

    await expect(
      sendGovernedRequest(http, { url: "https://example.com/docs", method: "GET" })
    ).resolves.toMatchObject({ kind: "response", url: "https://example.com/plain" });
    expect(sent).toEqual(["https://example.com/docs", "https://example.com/plain"]);
  });

  it("re-checks the www. host against whatever narrowed the request, not only the first URL", async () => {
    // A Skill declares `example.com`. `www.example.com` is a host it never declared and which can
    // be taken over independently of the apex, so the caller's own check must see it too.
    const { http, sent } = redirectingTo("https://www.example.com/docs");
    const declared = ["https://example.com"];

    await expect(
      sendGovernedRequest(http, {
        url: "https://example.com/docs",
        method: "GET",
        assertDestination: (origin) => {
          if (!declared.includes(origin)) throw new Error(`destination "${origin}" not declared`);
        },
      })
    ).rejects.toThrow('destination "https://www.example.com" not declared');
    expect(sent).toEqual(["https://example.com/docs"]);
  });

  it("does not re-ask when the redirect stays on the origin already approved", async () => {
    const { http } = redirectingTo("https://example.com/docs/v2");
    const assertDestination = vi.fn();

    await expect(
      sendGovernedRequest(http, {
        url: "https://example.com/docs",
        method: "GET",
        assertDestination,
      })
    ).resolves.toMatchObject({ kind: "response" });
    expect(assertDestination).not.toHaveBeenCalled();
  });

  it("refuses to carry a Secret onto the www. host, whatever header it was named in", async () => {
    const { http, sent } = redirectingTo("https://www.example.com/me");
    await expect(
      sendGovernedRequest(http, {
        url: "https://example.com/me",
        method: "GET",
        // A Credential may name any header, so the caller declares it rather than the transport
        // guessing from a name it does not control.
        carriesCredential: true,
        headers: { "X-Service-Key": "leased-value" },
      })
    ).resolves.toMatchObject({ kind: "cross_origin_redirect", to: "https://www.example.com/me" });
    expect(sent).toEqual(["https://example.com/me"]);
  });

  it("still refuses when a caller attached an obvious auth header and forgot to declare it", async () => {
    const { http, sent } = redirectingTo("https://www.example.com/me");
    await expect(
      sendGovernedRequest(http, {
        url: "https://example.com/me",
        method: "GET",
        headers: { authorization: "Bearer leased-value" },
      })
    ).resolves.toMatchObject({ kind: "cross_origin_redirect", to: "https://www.example.com/me" });
    expect(sent).toEqual(["https://example.com/me"]);
  });

  it("still refuses a redirect to an unrelated host", async () => {
    const { http } = redirectingTo("https://evil.example.net/steal");
    await expect(
      sendGovernedRequest(http, { url: "https://example.com/docs", method: "GET" })
    ).resolves.toMatchObject({ kind: "cross_origin_redirect" });
  });

  it("still refuses a same-name host reached over a different port", async () => {
    const { http } = redirectingTo("https://www.example.com:8443/docs");
    await expect(
      sendGovernedRequest(http, { url: "https://example.com/docs", method: "GET" })
    ).resolves.toMatchObject({ kind: "cross_origin_redirect" });
  });
});
