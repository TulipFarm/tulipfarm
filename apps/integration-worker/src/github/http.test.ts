import { describe, expect, it } from "vitest";
import { GITHUB_API_BASE_URL, GitHubRestHttp } from "./http";

function fakeFetch(capture: { url?: string; init?: RequestInit }, response: Response) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    capture.url = String(url);
    capture.init = init;
    return response;
  };
}

describe("GitHubRestHttp", () => {
  it("sends the leased credential as a bearer token against the GitHub REST API", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const http = new GitHubRestHttp({
      fetch: fakeFetch(
        capture,
        new Response(JSON.stringify({ number: 41 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      ),
    });

    const response = await http.send(
      { method: "GET", path: "/repos/tulip/farm/issues/41" },
      "ghs_token"
    );

    expect(capture.url).toBe(`${GITHUB_API_BASE_URL}/repos/tulip/farm/issues/41`);
    expect(new Headers(capture.init?.headers).get("authorization")).toBe("Bearer ghs_token");
    expect(new Headers(capture.init?.headers).get("x-github-api-version")).toBe("2022-11-28");
    expect(response).toMatchObject({ status: 200, body: { number: 41 } });
  });

  it("serializes query parameters and JSON bodies", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const http = new GitHubRestHttp({
      fetch: fakeFetch(capture, new Response("[]", { status: 201 })),
    });

    await http.send(
      { method: "POST", path: "/search/issues", query: { q: "repo:tulip/farm" }, body: { a: 1 } },
      "ghs_token"
    );

    expect(capture.url).toBe(`${GITHUB_API_BASE_URL}/search/issues?q=repo%3Atulip%2Ffarm`);
    expect(capture.init?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("returns a non-2xx response for the adapter to classify rather than throwing", async () => {
    const http = new GitHubRestHttp({
      fetch: fakeFetch({}, new Response("", { status: 429, headers: { "retry-after": "7" } })),
    });

    const response = await http.send({ method: "GET", path: "/rate_limit" }, "ghs_token");
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("7");
  });
});
