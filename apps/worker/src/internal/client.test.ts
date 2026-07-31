import { describe, expect, it } from "vitest";
import { InternalApiClient, InternalApiError } from "./client";

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: string | null;
}

function stubFetch(responses: Response[]): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = queue.shift();
    if (!next) throw new Error("unexpected call");
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function client(responses: Response[]): {
  api: InternalApiClient;
  calls: RecordedCall[];
} {
  const { fetch, calls } = stubFetch(responses);
  return {
    api: new InternalApiClient({
      baseUrl: "http://api:4010",
      credential: "tfc_client.secret",
      fetch,
    }),
    calls,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("InternalApiClient", () => {
  it("carries the service credential and the base url on every call", async () => {
    const { api, calls } = client([json({ ok: true })]);

    await api.require("POST", "/api/v1/internal/turns/run-1/context", { attempt: 1 });

    expect(calls[0]).toEqual({
      url: "http://api:4010/api/v1/internal/turns/run-1/context",
      method: "POST",
      authorization: "Bearer tfc_client.secret",
      contentType: "application/json",
      body: JSON.stringify({ attempt: 1 }),
    });
  });

  it("sends no content-type when there is no body to describe", async () => {
    const { api, calls } = client([json({ ok: true })]);

    await api.require("GET", "/api/v1/internal/llm/config");

    expect(calls[0]?.contentType).toBeNull();
    expect(calls[0]?.body).toBeNull();
  });

  it("treats a required answer that is missing as a fault, including an empty 204", async () => {
    // A caller that asked for a Context has nothing to fall back on, so "no body" is not an answer.
    const { api } = client([new Response(null, { status: 204 })]);

    await expect(api.require("GET", "/api/v1/internal/turns/run-1")).rejects.toBeInstanceOf(
      InternalApiError
    );
  });

  it("reports the status and the host's detail when a call is refused", async () => {
    const { api } = client([new Response("run is not operable", { status: 409 })]);

    const raised = await api
      .require("POST", "/api/v1/internal/turns/run-1/tools")
      .catch((cause: unknown) => cause);

    expect(raised).toBeInstanceOf(InternalApiError);
    const error = raised as InternalApiError;
    expect(error.status).toBe(409);
    expect(error.message).toContain("409");
    expect(error.message).toContain("run is not operable");
  });

  it("reads absence only from the statuses the caller named", async () => {
    // The distinction is load-bearing: on a completion lookup `204` means "this attempt has not
    // finished", while `404` means the Run is gone. Reading the second as the first would let a
    // redelivered job post a second answer.
    const { api } = client([new Response(null, { status: 204 }), json({ gone: true }, 404)]);

    await expect(api.find("GET", "/api/v1/internal/x", [204])).resolves.toBeUndefined();
    await expect(api.find("GET", "/api/v1/internal/x", [204])).rejects.toBeInstanceOf(
      InternalApiError
    );
  });

  it("returns the body when a findable call does answer", async () => {
    const { api } = client([json({ turnId: "turn-1" })]);

    await expect(api.find("GET", "/api/v1/internal/turns/run-1", [404, 409])).resolves.toEqual({
      turnId: "turn-1",
    });
  });
});
