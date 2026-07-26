import { describe, expect, it } from "vitest";
import { SlackWebApiHttp } from "./http";
import { slackReconnectDelay } from "./worker";

function fakeFetch(capture: { url?: string; init?: RequestInit }, response: Response) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    capture.url = String(url);
    capture.init = init;
    return response;
  };
}

describe("SlackWebApiHttp", () => {
  it("uses one leased bot Credential and does not retain it", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const http = new SlackWebApiHttp({
      fetch: fakeFetch(
        capture,
        new Response(JSON.stringify({ ok: true, ts: "1.2" }), { status: 200 })
      ),
    });

    await http.send(
      { method: "POST", path: "/chat.postMessage", body: { channel: "C1", text: "hi" } },
      "xoxb-leased"
    );

    expect(capture.url).toBe("https://slack.com/api/chat.postMessage");
    expect(new Headers(capture.init?.headers).get("authorization")).toBe("Bearer xoxb-leased");
    expect(capture.init?.body).toBe(JSON.stringify({ channel: "C1", text: "hi" }));
    expect(JSON.stringify(http)).not.toContain("xoxb-leased");
  });

  it("turns transport failures into an opaque retryable response", async () => {
    const http = new SlackWebApiHttp({
      fetch: async () => {
        throw new Error("request failed with authorization: Bearer xoxb-leased");
      },
    });

    const response = await http.send(
      { method: "POST", path: "/chat.postMessage", body: { channel: "C1", text: "hi" } },
      "xoxb-leased"
    );

    expect(response).toEqual({ status: 503, headers: {}, body: undefined });
    expect(JSON.stringify(response)).not.toContain("xoxb-leased");
  });
});

describe("slackReconnectDelay", () => {
  it("uses capped exponential backoff with bounded jitter", () => {
    expect(slackReconnectDelay(0, { jitter: () => 0 })).toBe(500);
    expect(slackReconnectDelay(1, { jitter: () => 0.5 })).toBe(1500);
    expect(slackReconnectDelay(20, { jitter: () => 1 })).toBe(30_000);
  });
});
