import { AdapterDispatchError, type ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import type { IntegrationHttpResponse } from "../http";
import { type EgressHttpPort, type EgressHttpRequest, OpenApiToolAdapter } from "./openapi-adapter";
import type { OpenApiOperationBinding } from "./openapi-compile";

class RecordingHttp implements EgressHttpPort {
  readonly sent: EgressHttpRequest[] = [];

  constructor(private readonly response: IntegrationHttpResponse) {}

  async send(request: EgressHttpRequest): Promise<IntegrationHttpResponse> {
    this.sent.push(request);
    return this.response;
  }
}

const OK: IntegrationHttpResponse = { status: 200, headers: {}, body: { ok: true } };

function binding(overrides: Partial<OpenApiOperationBinding> = {}): OpenApiOperationBinding {
  return {
    method: "GET",
    baseUrl: "https://api.example.com/v1",
    pathTemplate: "/pages/{page_id}",
    mutating: false,
    params: [
      { name: "page_id", in: "path" },
      { name: "filter", in: "query" },
      { name: "X-Trace", in: "header" },
    ],
    hasBody: false,
    headers: {},
    ...overrides,
  };
}

function request(args: unknown): ToolAdapterRequest {
  return {
    intent: {
      intentId: "i",
      businessId: "b",
      runId: "r",
      stateId: "s",
      toolId: "openapi.acme.get_page",
      toolVersion: "1.0.0",
      action: "getPage",
      targetRefs: [],
      arguments: args,
      idempotencyKey: "k",
    },
    idempotencyKey: "k",
    attempt: 1,
  } as ToolAdapterRequest;
}

describe("OpenApiToolAdapter", () => {
  it("places each argument where the binding says it belongs", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenApiToolAdapter({ binding: binding(), http });

    await adapter.dispatch(request({ page_id: "p1", filter: "open", "X-Trace": "t9" }));

    const [sent] = http.sent;
    expect(sent?.url).toBe("https://api.example.com/v1/pages/p1?filter=open");
    expect(sent?.headers["X-Trace"]).toBe("t9");
  });

  it("percent-encodes a path argument so it cannot escape its segment", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenApiToolAdapter({ binding: binding(), http });

    await adapter.dispatch(request({ page_id: "../../admin" }));

    expect(http.sent[0]?.url).toBe("https://api.example.com/v1/pages/..%2F..%2Fadmin");
  });

  it("refuses to call when a path argument is missing rather than sending the placeholder", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenApiToolAdapter({ binding: binding(), http });

    await expect(adapter.dispatch(request({ filter: "open" }))).rejects.toThrow(
      AdapterDispatchError
    );
    expect(http.sent).toHaveLength(0);
  });

  it("omits an absent optional parameter instead of sending an empty value", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenApiToolAdapter({ binding: binding(), http });

    await adapter.dispatch(request({ page_id: "p1" }));

    expect(http.sent[0]?.url).toBe("https://api.example.com/v1/pages/p1");
  });

  it("applies the declared auth header format", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenApiToolAdapter({
      binding: binding({ auth: { in: "header", header: "X-Api-Key", format: "{token}" } }),
      http,
    });

    await adapter.dispatch(request({ page_id: "p1" }), "secret-token");

    expect(http.sent[0]?.headers["X-Api-Key"]).toBe("secret-token");
  });

  it("refuses to dispatch without the credential its binding requires", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenApiToolAdapter({
      binding: binding({
        auth: { in: "header", header: "Authorization", format: "Bearer {token}" },
      }),
      http,
    });

    await expect(adapter.dispatch(request({ page_id: "p1" }))).rejects.toThrow(
      AdapterDispatchError
    );
    expect(http.sent).toHaveLength(0);
  });

  it("sends the static manifest headers on every call", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenApiToolAdapter({
      binding: binding({ headers: { "Notion-Version": "2022-06-28" } }),
      http,
    });

    await adapter.dispatch(request({ page_id: "p1" }));

    expect(http.sent[0]?.headers["Notion-Version"]).toBe("2022-06-28");
  });

  it("sends the body argument as JSON when the operation takes one", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenApiToolAdapter({
      binding: binding({
        method: "POST",
        pathTemplate: "/search",
        params: [],
        hasBody: true,
        mutating: true,
      }),
      http,
    });

    await adapter.dispatch(request({ body: { query: "roadmap" } }));

    expect(http.sent[0]?.body).toEqual({ query: "roadmap" });
    expect(http.sent[0]?.headers["content-type"]).toBe("application/json");
  });

  it("returns the provider's response body on success", async () => {
    const adapter = new OpenApiToolAdapter({
      binding: binding(),
      http: new RecordingHttp({ status: 200, headers: {}, body: { title: "Roadmap" } }),
    });

    await expect(adapter.dispatch(request({ page_id: "p1" }))).resolves.toEqual({
      title: "Roadmap",
    });
  });

  it("maps a provider error status onto a dispatch error", async () => {
    const adapter = new OpenApiToolAdapter({
      binding: binding(),
      http: new RecordingHttp({ status: 401, headers: {}, body: {} }),
    });

    await expect(adapter.dispatch(request({ page_id: "p1" }))).rejects.toMatchObject({
      code: "provider_unauthorized",
      phase: "before_dispatch",
    });
  });

  it("classifies a failed mutation as after_dispatch so it is reconciled, not retried", async () => {
    const adapter = new OpenApiToolAdapter({
      binding: binding({ method: "POST", mutating: true, params: [], pathTemplate: "/search" }),
      http: new RecordingHttp({ status: 503, headers: {}, body: {} }),
    });

    await expect(adapter.dispatch(request({}))).rejects.toMatchObject({
      phase: "after_dispatch",
    });
  });

  it("trusts the contract's mutating flag over the HTTP verb when classifying", async () => {
    const adapter = new OpenApiToolAdapter({
      binding: binding({ method: "POST", mutating: false, params: [], pathTemplate: "/search" }),
      http: new RecordingHttp({ status: 503, headers: {}, body: {} }),
    });

    await expect(adapter.dispatch(request({}))).rejects.toMatchObject({
      phase: "before_dispatch",
    });
  });

  it("rejects arguments that are not an object", async () => {
    const adapter = new OpenApiToolAdapter({ binding: binding(), http: new RecordingHttp(OK) });

    await expect(adapter.dispatch(request("nope"))).rejects.toThrow(AdapterDispatchError);
  });
});

describe("OpenApiToolAdapter base_url credential placement", () => {
  it("substitutes the credential into the base URL and sends no auth header", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenApiToolAdapter({
      binding: binding({
        auth: { in: "base_url" },
        baseUrl: "https://api.telegram.org/bot{token}",
      }),
      http,
    });

    await adapter.dispatch(request({ page_id: "p1" }), "123:AAE-secret");

    expect(http.sent[0]?.url).toBe("https://api.telegram.org/bot123:AAE-secret/pages/p1");
    expect(http.sent[0]?.headers.Authorization).toBeUndefined();
  });

  it("refuses a credential that would restructure the URL", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenApiToolAdapter({
      binding: binding({
        auth: { in: "base_url" },
        baseUrl: "https://api.telegram.org/bot{token}",
      }),
      http,
    });

    for (const hostile of ["a/../evil", "a?x=1", "a#f", "a%2Fb", "a b"]) {
      await expect(adapter.dispatch(request({ page_id: "p1" }), hostile)).rejects.toThrow(
        AdapterDispatchError
      );
    }
    expect(http.sent).toHaveLength(0);
  });

  it("refuses to dispatch without the credential the URL depends on", async () => {
    const http = new RecordingHttp(OK);
    const adapter = new OpenApiToolAdapter({
      binding: binding({
        auth: { in: "base_url" },
        baseUrl: "https://api.telegram.org/bot{token}",
      }),
      http,
    });

    await expect(adapter.dispatch(request({ page_id: "p1" }))).rejects.toThrow(
      AdapterDispatchError
    );
    // Never send the placeholder unsubstituted: that leaks the shape of the URL to a stranger.
    expect(http.sent).toHaveLength(0);
  });
});
