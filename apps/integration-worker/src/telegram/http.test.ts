import { describe, expect, it } from "vitest";
import { TelegramBotApiHttp } from "./http";
import { telegramReconnectDelay } from "./worker";

function fakeFetch(capture: { url?: string; init?: RequestInit }, response: Response) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    capture.url = String(url);
    capture.init = init;
    return response;
  };
}

describe("TelegramBotApiHttp", () => {
  it("scopes the leased bot Credential to one Bot API request and does not retain it", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const http = new TelegramBotApiHttp({
      fetch: fakeFetch(
        capture,
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })
      ),
    });

    await http.send(
      { method: "POST", path: "/sendMessage", body: { chat_id: "42", text: "hi" } },
      "123456:leased-token"
    );

    expect(capture.url).toBe("https://api.telegram.org/bot123456:leased-token/sendMessage");
    expect(capture.init?.body).toBe(JSON.stringify({ chat_id: "42", text: "hi" }));
    expect(JSON.stringify(http)).not.toContain("leased-token");
  });

  it("redacts transport failures that could contain the bot Credential", async () => {
    const http = new TelegramBotApiHttp({
      fetch: async () => {
        throw new Error("request failed for /bot123456:leased-token/sendMessage");
      },
    });

    const response = await http.send(
      { method: "POST", path: "/sendMessage", body: { chat_id: "42", text: "hi" } },
      "123456:leased-token"
    );

    expect(response).toEqual({ status: 503, headers: {}, body: undefined });
    expect(JSON.stringify(response)).not.toContain("leased-token");
  });
});

describe("telegramReconnectDelay", () => {
  it("uses capped exponential backoff with bounded jitter", () => {
    expect(telegramReconnectDelay(0, { jitter: () => 0 })).toBe(500);
    expect(telegramReconnectDelay(1, { jitter: () => 0.5 })).toBe(1500);
    expect(telegramReconnectDelay(20, { jitter: () => 1 })).toBe(30_000);
  });
});
