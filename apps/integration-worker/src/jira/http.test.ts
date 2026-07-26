import { describe, expect, it } from "vitest";
import { JIRA_API_BASE_URL, JiraRestHttp } from "./http";

function fakeFetch(capture: { url?: string; init?: RequestInit }, response: Response) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    capture.url = String(url);
    capture.init = init;
    return response;
  };
}

describe("JiraRestHttp", () => {
  it("routes through the installed site's cloud id with the leased token", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const http = new JiraRestHttp({
      cloudId: "cloud-9",
      fetch: fakeFetch(capture, new Response(JSON.stringify({ key: "FARM-12" }), { status: 200 })),
    });

    const response = await http.send(
      { method: "GET", path: "/rest/api/3/issue/FARM-12", query: { expand: "names" } },
      "jira_token"
    );

    expect(capture.url).toBe(`${JIRA_API_BASE_URL}/cloud-9/rest/api/3/issue/FARM-12?expand=names`);
    expect(new Headers(capture.init?.headers).get("authorization")).toBe("Bearer jira_token");
    expect(response).toMatchObject({ status: 200, body: { key: "FARM-12" } });
  });

  it("returns an empty transition response instead of failing to parse it", async () => {
    const http = new JiraRestHttp({
      cloudId: "cloud-9",
      fetch: fakeFetch({}, new Response(null, { status: 204 })),
    });

    const response = await http.send(
      { method: "POST", path: "/rest/api/3/issue/FARM-12/transitions", body: { transition: {} } },
      "jira_token"
    );
    expect(response.status).toBe(204);
    expect(response.body).toBeUndefined();
  });

  it("returns a non-2xx response for the adapter to classify rather than throwing", async () => {
    const http = new JiraRestHttp({
      cloudId: "cloud-9",
      fetch: fakeFetch({}, new Response("", { status: 429, headers: { "retry-after": "3" } })),
    });

    const response = await http.send({ method: "GET", path: "/rest/api/3/myself" }, "jira_token");
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("3");
  });
});
