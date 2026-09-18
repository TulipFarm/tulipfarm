import { describe, expect, it, vi } from "vitest";
import { GitHubInstallHttp } from "./github-http";

describe("GitHub native transport", () => {
  it("preserves encoded path segments and literal query values", async () => {
    const path = "docs #?/literal%23%2F/notes#2026?.md";
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ path }), { status: 200 }));
    const http = new GitHubInstallHttp({ fetch });
    await http.send(
      {
        method: "GET",
        path: `/repos/tulip/farm/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
        query: { ref: "feature/#?%" },
      },
      "fixture-token"
    );
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(
      "/repos/tulip/farm/contents/docs%20%23%3F/literal%2523%252F/notes%232026%3F.md"
    );
    expect(url.hash).toBe("");
    expect([...url.searchParams]).toEqual([["ref", "feature/#?%"]]);
    expect(url.pathname.split("/").slice(5).map(decodeURIComponent).join("/")).toBe(path);
  });

  it("sends a native installation-token request with its exact repository scope", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ token: "installation-token" }), { status: 201 })
      );
    const body = { repositories: ["farm"], permissions: { issues: "write" } };
    const result = await new GitHubInstallHttp({ fetch }).send(
      { method: "POST", path: "/app/installations/42/access_tokens", body },
      "app-jwt"
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/42/access_tokens",
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: "Bearer app-jwt",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ token: "installation-token" });
  });
});
