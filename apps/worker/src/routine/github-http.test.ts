import { describe, expect, it, vi } from "vitest";
import { GITHUB_API_BASE_URL, GitHubRestHttp } from "./github-http";

function fetchReturning(response: Partial<Response> & { text: () => Promise<string> }) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response as Response);
}

describe("GitHubRestHttp", () => {
  it("builds the request with bearer auth, API version header, and query params", async () => {
    const fetchImpl = fetchReturning({
      status: 200,
      headers: new Headers({ "x-ok": "1" }),
      text: async () => JSON.stringify({ hello: "world" }),
    });
    const http = new GitHubRestHttp({ fetch: fetchImpl });

    const response = await http.send(
      { method: "GET", path: "/repos/tulip/farm/issues", query: { state: "open" } },
      "token-abc"
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GITHUB_API_BASE_URL}/repos/tulip/farm/issues?state=open`);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-abc");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
    expect(init.body).toBeUndefined();
    expect(response).toEqual({ status: 200, headers: { "x-ok": "1" }, body: { hello: "world" } });
  });

  it("serializes a body and sets content-type only when a body is present", async () => {
    const fetchImpl = fetchReturning({
      status: 201,
      headers: new Headers(),
      text: async () => "",
    });
    const http = new GitHubRestHttp({ fetch: fetchImpl });

    await http.send(
      { method: "POST", path: "/repos/tulip/farm/issues/1/comments", body: { body: "hi" } },
      "token-abc"
    );

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ body: "hi" }));
  });

  it("treats an empty response body as undefined rather than a parse failure", async () => {
    const fetchImpl = fetchReturning({ status: 204, headers: new Headers(), text: async () => "" });
    const http = new GitHubRestHttp({ fetch: fetchImpl });
    const response = await http.send({ method: "DELETE", path: "/repos/tulip/farm/issues/1" }, "t");
    expect(response.body).toBeUndefined();
  });

  it("falls back to raw text when the response body is not JSON", async () => {
    const fetchImpl = fetchReturning({
      status: 200,
      headers: new Headers(),
      text: async () => "not json",
    });
    const http = new GitHubRestHttp({ fetch: fetchImpl });
    const response = await http.send({ method: "GET", path: "/repos/tulip/farm" }, "t");
    expect(response.body).toBe("not json");
  });
});
