import type { OimManifest } from "@tulipfarm/schema";
import type { ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationHttpResponse } from "../http";
import type { OimHookPhaseRunner } from "../oim-hooks";
import type { OimFilePort } from "./oim-files";
import { createOimFixturePaginationRuntime } from "./oim-fixture-codec";
import { OimHttpToolAdapter } from "./oim-http-adapter";
import {
  DEFAULT_OIM_PAGINATION_BOUNDS,
  type OimContinuationCodec,
  type OimContinuationState,
} from "./oim-pagination";
import type { EgressHttpPort, EgressHttpRequest } from "./openapi-adapter";

class RecordingHttp implements EgressHttpPort {
  readonly sent: EgressHttpRequest[] = [];

  constructor(private readonly response: IntegrationHttpResponse) {}

  async send(request: EgressHttpRequest): Promise<IntegrationHttpResponse> {
    this.sent.push(request);
    return this.response;
  }
}

class QueuedHttp implements EgressHttpPort {
  readonly sent: EgressHttpRequest[] = [];

  constructor(private readonly responses: readonly IntegrationHttpResponse[]) {}

  async send(request: EgressHttpRequest): Promise<IntegrationHttpResponse> {
    this.sent.push(request);
    const response = this.responses[this.sent.length - 1];
    if (response === undefined) throw new Error("missing queued response");
    return response;
  }
}

class RecordingContinuationCodec implements OimContinuationCodec {
  readonly sealed: OimContinuationState[] = [];
  private readonly states = new Map<string, OimContinuationState>();

  async seal(state: OimContinuationState): Promise<string> {
    const token = `continuation-${this.sealed.length + 1}`;
    const copy = structuredClone(state);
    this.sealed.push(copy);
    this.states.set(token, copy);
    return token;
  }

  async unseal(token: string): Promise<unknown> {
    return structuredClone(this.states.get(token));
  }
}

function request(
  args: Readonly<Record<string, unknown>> = { location: "london", units: "metric" }
): ToolAdapterRequest {
  return {
    intent: {
      intentId: "intent-1",
      businessId: "business-1",
      runId: "run-1",
      stateId: "state-1",
      toolId: "oim.weather.v1.current-weather",
      toolVersion: "1.2.3",
      action: "integration.weather.current_weather",
      targetRefs: [],
      arguments: args,
      idempotencyKey: "effect-1",
    },
    idempotencyKey: "effect-1",
    attempt: 1,
  };
}

function manifestWithResponseHook(): OimManifest {
  return {
    oimVersion: "1.0",
    metadata: {
      id: "weather",
      name: "Weather",
      description: "Weather provider",
      version: "1.0.0",
    },
    hooks: [
      {
        kind: "response_normalize",
        file: "hooks/normalize.js",
        export: "normalize",
      },
    ],
  } as unknown as OimManifest;
}

describe("OimHttpToolAdapter", () => {
  it("reuses HTTP parameter placement and passes the operation response bound", async () => {
    const http = new RecordingHttp({
      status: 200,
      headers: {},
      body: { temperature: 18, conditions: "cloudy", internal: "drop" },
    });
    const adapter = new OimHttpToolAdapter({
      http,
      binding: {
        method: "GET",
        baseUrl: "https://api.weather.example",
        pathTemplate: "/v1/current/{location}",
        mutating: false,
        params: [
          { name: "location", in: "path" },
          { name: "units", in: "query" },
        ],
        hasBody: false,
        maxResponseBytes: 16_384,
        headers: {},
      },
      projection: ["/temperature", "/conditions"],
    });

    await expect(adapter.dispatch(request())).resolves.toEqual({
      temperature: 18,
      conditions: "cloudy",
    });
    expect(http.sent[0]).toMatchObject({
      url: "https://api.weather.example/v1/current/london?units=metric",
      maxResponseBytes: 16_384,
    });
  });

  it("projects nested values without allowing prototype paths", async () => {
    const adapter = new OimHttpToolAdapter({
      http: new RecordingHttp({
        status: 200,
        headers: {},
        body: { current: { temperature: 18 }, constructor: { prototype: { polluted: true } } },
      }),
      binding: {
        method: "GET",
        baseUrl: "https://api.weather.example",
        pathTemplate: "/v1/current",
        mutating: false,
        params: [],
        hasBody: false,
        headers: {},
      },
      projection: ["/current/temperature", "/constructor/prototype/polluted"],
    });

    await expect(adapter.dispatch(request())).resolves.toEqual({
      current: { temperature: 18 },
    });
  });

  it("injects a query credential after model-visible arguments are fixed", async () => {
    const http = new RecordingHttp({ status: 200, headers: {}, body: {} });
    const adapter = new OimHttpToolAdapter({
      http,
      binding: {
        method: "GET",
        baseUrl: "https://api.weather.example",
        pathTemplate: "/v1/current",
        mutating: false,
        params: [{ name: "key", in: "query" }],
        hasBody: false,
        headers: {},
        auth: { in: "query", name: "key", format: "{token}" },
      },
    });
    await adapter.dispatch(request({ key: "model-value" }), "sealed-value");

    expect(http.sent[0]?.url).toBe("https://api.weather.example/v1/current?key=sealed-value");
  });

  it("redacts before the response Hook and projects the Hook output", async () => {
    const run = vi.fn<OimHookPhaseRunner["run"]>(async (_hook, input) => {
      expect(input).toEqual({
        payload: {
          access_token: "[redacted]",
          data: { temperature: 18 },
        },
        safeHeaders: {},
      });
      return { result: { temperature: 19 }, access_token: "still-hidden" };
    });
    const adapter = new OimHttpToolAdapter({
      http: new RecordingHttp({
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "secret=1" },
        body: { access_token: "secret", data: { temperature: 18 } },
      }),
      binding: {
        method: "GET",
        baseUrl: "https://api.weather.example",
        pathTemplate: "/v1/current",
        mutating: false,
        params: [],
        hasBody: false,
        headers: {},
      },
      projection: ["/result"],
      manifest: manifestWithResponseHook(),
      hookRunner: { run },
    });

    await expect(adapter.dispatch(request())).resolves.toEqual({
      result: { temperature: 19 },
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("fails after dispatch when a response Hook is declared without a trusted runner", async () => {
    const adapter = new OimHttpToolAdapter({
      http: new RecordingHttp({
        status: 200,
        headers: {},
        body: { temperature: 18 },
      }),
      binding: {
        method: "GET",
        baseUrl: "https://api.weather.example",
        pathTemplate: "/v1/current",
        mutating: false,
        params: [],
        hasBody: false,
        headers: {},
      },
      manifest: manifestWithResponseHook(),
    });

    await expect(adapter.dispatch(request())).rejects.toMatchObject({
      phase: "after_dispatch",
      code: "response_normalize_hook_failed",
      retryable: false,
    });
  });
});

describe("OimHttpToolAdapter pagination", () => {
  const binding = {
    method: "GET" as const,
    baseUrl: "https://api.weather.example",
    pathTemplate: "/v1/readings",
    mutating: false,
    params: [],
    hasBody: false,
    headers: {},
  };

  it("fails before HTTP when a paginated operation has no secure runtime", async () => {
    const http = new RecordingHttp({
      status: 200,
      headers: {},
      body: { values: [1], nextCursor: "page-2" },
    });
    const adapter = new OimHttpToolAdapter({
      http,
      binding,
      toolId: "oim.weather.v1.readings",
      pagination: { type: "cursor", requestParameter: "cursor", responsePath: "/nextCursor" },
    });

    await expect(adapter.dispatch(request({}))).rejects.toMatchObject({
      code: "pagination_runtime_missing",
      phase: "before_dispatch",
    });
    expect(http.sent).toHaveLength(0);
  });

  it("returns an opaque continuation token that never leaks the provider cursor", async () => {
    const http = new RecordingHttp({
      status: 200,
      headers: {},
      body: { values: [1, 2], nextCursor: "provider-cursor-xyz" },
    });

    const adapter = new OimHttpToolAdapter({
      http,
      binding,
      toolId: "oim.weather.v1.readings",
      paginationRuntime: createOimFixturePaginationRuntime(),
      pagination: { type: "cursor", requestParameter: "cursor", responsePath: "/nextCursor" },
    });

    const output = (await adapter.dispatch(request({}))) as Record<string, unknown>;

    expect(output.values).toEqual([1, 2]);
    expect(typeof output.next_page_token).toBe("string");
    expect(output.next_page_token).not.toContain("provider-cursor-xyz");
  });

  it("extracts a secret-shaped provider cursor before redaction and keeps it through projection", async () => {
    const http = new RecordingHttp({
      status: 200,
      headers: {},
      body: {
        values: [1, 2],
        next_page_token: "provider-page-2",
        access_token: "must-not-leak",
      },
    });
    const adapter = new OimHttpToolAdapter({
      http,
      binding,
      toolId: "oim.weather.v1.readings",
      paginationRuntime: createOimFixturePaginationRuntime(),
      pagination: {
        type: "cursor",
        requestParameter: "cursor",
        responsePath: "/next_page_token",
      },
      projection: ["/values"],
    });

    const first = (await adapter.dispatch(request({}))) as Record<string, unknown>;
    const token = first.next_page_token;
    expect(first).toEqual({ values: [1, 2], next_page_token: expect.any(String) });
    expect(JSON.stringify(first)).not.toContain("provider-page-2");
    expect(JSON.stringify(first)).not.toContain("must-not-leak");

    await adapter.dispatch(request({ page_token: token }));
    expect(http.sent[1]?.url).toBe(
      "https://api.weather.example/v1/readings?cursor=provider-page-2"
    );
  });

  it("sends the declared first page and increments without duplicate pagination arguments", async () => {
    const http = new RecordingHttp({
      status: 200,
      headers: {},
      body: { values: [1] },
    });
    const adapter = new OimHttpToolAdapter({
      http,
      binding,
      toolId: "oim.weather.v1.readings",
      paginationRuntime: createOimFixturePaginationRuntime(),
      pagination: { type: "page", requestParameter: "page", itemsPath: "/values" },
    });

    const first = (await adapter.dispatch(request({}))) as Record<string, unknown>;
    await adapter.dispatch(request({ page_token: first.next_page_token }));

    expect(http.sent.map((sent) => sent.url)).toEqual([
      "https://api.weather.example/v1/readings?page=1",
      "https://api.weather.example/v1/readings?page=2",
    ]);
  });

  it("wraps a paginated top-level array in a stable items envelope", async () => {
    const http = new QueuedHttp([
      {
        status: 200,
        headers: {},
        body: [{ id: 1 }, { id: 2 }],
      },
      { status: 200, headers: {}, body: [] },
    ]);
    const adapter = new OimHttpToolAdapter({
      http,
      binding,
      toolId: "oim.weather.v1.readings",
      paginationRuntime: createOimFixturePaginationRuntime(),
      pagination: { type: "page", requestParameter: "page" },
    });

    const first = (await adapter.dispatch(request({}))) as Record<string, unknown>;
    expect(first).toEqual({
      items: [{ id: 1 }, { id: 2 }],
      next_page_token: expect.any(String),
    });
    await expect(adapter.dispatch(request({ page_token: first.next_page_token }))).resolves.toEqual(
      {
        items: [],
      }
    );
  });

  it("validates the raw provider array before response normalization", async () => {
    const run = vi.fn<OimHookPhaseRunner["run"]>(async () => [{ id: 1 }]);
    const adapter = new OimHttpToolAdapter({
      http: new RecordingHttp({
        status: 200,
        headers: {},
        body: [{ id: "not-an-integer" }],
      }),
      binding: {
        ...binding,
        responseSchema: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "integer" } },
            required: ["id"],
          },
        },
      },
      manifest: manifestWithResponseHook(),
      hookRunner: { run },
      toolId: "oim.weather.v1.readings",
      paginationRuntime: createOimFixturePaginationRuntime(),
      pagination: { type: "page", requestParameter: "page" },
    });

    await expect(adapter.dispatch(request({}))).rejects.toMatchObject({
      phase: "after_dispatch",
      code: "invalid_output",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("resumes with the provider cursor the token stands for", async () => {
    const http = new RecordingHttp({
      status: 200,
      headers: {},
      body: { values: [1], nextCursor: "page-2" },
    });
    const adapter = new OimHttpToolAdapter({
      http,
      binding,
      toolId: "oim.weather.v1.readings",
      paginationRuntime: createOimFixturePaginationRuntime(),
      pagination: { type: "cursor", requestParameter: "cursor", responsePath: "/nextCursor" },
    });
    const first = (await adapter.dispatch(request({}))) as Record<string, unknown>;

    await adapter.dispatch(request({ page_token: first.next_page_token }));

    expect(http.sent[1]?.url).toBe("https://api.weather.example/v1/readings?cursor=page-2");
  });

  it("resolves relative next links against each fully assembled request URL", async () => {
    const http = new QueuedHttp([
      {
        status: 200,
        headers: { link: '<?cursor=next>; rel="next"' },
        body: { values: [1] },
      },
      {
        status: 200,
        headers: { link: '<archive?cursor=final>; rel="next"' },
        body: { values: [2] },
      },
      {
        status: 200,
        headers: {},
        body: { values: [3] },
      },
    ]);
    const adapter = new OimHttpToolAdapter({
      http,
      binding: {
        ...binding,
        pathTemplate: "/v1/{stream}/readings",
        params: [
          { name: "stream", in: "path" },
          { name: "limit", in: "query" },
        ],
      },
      toolId: "oim.weather.v1.readings",
      paginationRuntime: createOimFixturePaginationRuntime(),
      pagination: { type: "link" },
    });

    const first = (await adapter.dispatch(request({ stream: "hourly", limit: 25 }))) as Record<
      string,
      unknown
    >;
    const second = (await adapter.dispatch(
      request({ stream: "hourly", limit: 25, page_token: first.next_page_token })
    )) as Record<string, unknown>;
    await adapter.dispatch(
      request({ stream: "hourly", limit: 25, page_token: second.next_page_token })
    );

    expect(http.sent.map(({ url }) => url)).toEqual([
      "https://api.weather.example/v1/hourly/readings?limit=25",
      "https://api.weather.example/v1/hourly/readings?cursor=next",
      "https://api.weather.example/v1/hourly/archive?cursor=final",
    ]);
  });

  it("reapplies every current query credential without sealing any credential", async () => {
    const http = new QueuedHttp([
      {
        status: 200,
        headers: { link: '<?cursor=next>; rel="next"' },
        body: { values: [1] },
      },
      {
        status: 200,
        headers: {},
        body: { values: [2] },
      },
    ]);
    const codec = new RecordingContinuationCodec();
    const adapter = new OimHttpToolAdapter({
      http,
      binding: {
        ...binding,
        params: [{ name: "limit", in: "query" }],
        auth: {
          in: "query",
          name: "api_key",
          format: "{token}",
          credentialSlot: "api_key",
        },
        secondaryAuth: {
          in: "query",
          name: "token",
          format: "{token}",
          credentialSlot: "token",
        },
      },
      toolId: "oim.weather.v1.readings",
      paginationRuntime: { codec, now: () => 1_000 },
      pagination: { type: "link" },
    });

    const first = (await adapter.dispatch(request({ limit: 25 }), undefined, {
      api_key: "old-key",
      token: "old-token",
    })) as Record<string, unknown>;
    await adapter.dispatch(request({ page_token: first.next_page_token }), undefined, {
      api_key: "new-key",
      token: "new-token",
    });

    expect(http.sent.map(({ url }) => url)).toEqual([
      "https://api.weather.example/v1/readings?limit=25&api_key=old-key&token=old-token",
      "https://api.weather.example/v1/readings?cursor=next&api_key=new-key&token=new-token",
    ]);
    expect(JSON.stringify(first)).not.toContain("old-key");
    expect(JSON.stringify(first)).not.toContain("old-token");
    expect(JSON.stringify(codec.sealed)).not.toContain("old-key");
    expect(JSON.stringify(codec.sealed)).not.toContain("old-token");
    expect(JSON.stringify(codec.sealed)).not.toContain("new-key");
    expect(JSON.stringify(codec.sealed)).not.toContain("new-token");
  });

  it("reapplies rotating base URL credentials to root-relative and absolute links", async () => {
    const http = new QueuedHttp([
      {
        status: 200,
        headers: { link: '</botold-secret/v1/readings?cursor=next>; rel="next"' },
        body: { values: [1] },
      },
      {
        status: 200,
        headers: {
          link: '<https://api.weather.example/botnew-secret/v1/archive?cursor=final>; rel="next"',
        },
        body: { values: [2] },
      },
      {
        status: 200,
        headers: {},
        body: { values: [3] },
      },
    ]);
    const codec = new RecordingContinuationCodec();
    const adapter = new OimHttpToolAdapter({
      http,
      binding: {
        ...binding,
        baseUrl: "https://api.weather.example/bot{token}",
        auth: { in: "base_url" },
      },
      toolId: "oim.weather.v1.readings",
      paginationRuntime: { codec, now: () => 1_000 },
      pagination: { type: "link" },
    });

    const first = (await adapter.dispatch(request({}), "old-secret")) as Record<string, unknown>;
    const second = (await adapter.dispatch(
      request({ page_token: first.next_page_token }),
      "new-secret"
    )) as Record<string, unknown>;
    await adapter.dispatch(request({ page_token: second.next_page_token }), "fresh-secret");

    expect(http.sent.map(({ url }) => url)).toEqual([
      "https://api.weather.example/botold-secret/v1/readings",
      "https://api.weather.example/botnew-secret/v1/readings?cursor=next",
      "https://api.weather.example/botfresh-secret/v1/archive?cursor=final",
    ]);
    expect(JSON.stringify(first)).not.toContain("old-secret");
    expect(JSON.stringify(second)).not.toContain("new-secret");
    expect(JSON.stringify(codec.sealed)).not.toContain("old-secret");
    expect(JSON.stringify(codec.sealed)).not.toContain("new-secret");
    expect(JSON.stringify(codec.sealed)).not.toContain("fresh-secret");
  });

  it("refuses a page token minted for a different Tool instead of calling the provider", async () => {
    const paginationRuntime = createOimFixturePaginationRuntime();
    const http = new RecordingHttp({ status: 200, headers: {}, body: {} });
    const adapter = new OimHttpToolAdapter({
      http,
      binding,
      toolId: "oim.weather.v1.readings",
      paginationRuntime,
      pagination: { type: "cursor", requestParameter: "cursor", responsePath: "/nextCursor" },
    });
    const other = new OimHttpToolAdapter({
      http: new RecordingHttp({
        status: 200,
        headers: {},
        body: { values: [1], nextCursor: "page-2" },
      }),
      binding,
      toolId: "oim.other.v1.readings",
      paginationRuntime,
      pagination: { type: "cursor", requestParameter: "cursor", responsePath: "/nextCursor" },
    });
    const first = (await other.dispatch(request({}))) as Record<string, unknown>;

    await expect(
      adapter.dispatch(request({ page_token: first.next_page_token }))
    ).rejects.toMatchObject({
      code: "invalid_page_token",
      phase: "before_dispatch",
    });
    expect(http.sent).toHaveLength(0);
  });

  it("omits the token when the provider reports no further pages", async () => {
    const http = new RecordingHttp({ status: 200, headers: {}, body: { values: [1] } });
    const adapter = new OimHttpToolAdapter({
      http,
      binding,
      toolId: "oim.weather.v1.readings",
      paginationRuntime: createOimFixturePaginationRuntime(),
      pagination: { type: "cursor", requestParameter: "cursor", responsePath: "/nextCursor" },
    });

    const output = (await adapter.dispatch(request({}))) as Record<string, unknown>;

    expect(output).not.toHaveProperty("next_page_token");
  });

  it("rejects an expired token before sending the resumed HTTP request", async () => {
    let now = 1_000;
    const runtime = createOimFixturePaginationRuntime(() => now);
    const http = new RecordingHttp({
      status: 200,
      headers: {},
      body: { values: [1], nextCursor: "page-2" },
    });
    const adapter = new OimHttpToolAdapter({
      http,
      binding,
      toolId: "oim.weather.v1.readings",
      paginationRuntime: runtime,
      pagination: { type: "cursor", requestParameter: "cursor", responsePath: "/nextCursor" },
    });
    const first = (await adapter.dispatch(request({}))) as Record<string, unknown>;
    now += DEFAULT_OIM_PAGINATION_BOUNDS.maxDurationMs;

    await expect(
      adapter.dispatch(request({ page_token: first.next_page_token }))
    ).rejects.toMatchObject({
      code: "pagination_bound_exceeded",
      phase: "before_dispatch",
    });
    expect(http.sent).toHaveLength(1);
  });
});

describe("OimHttpToolAdapter files", () => {
  const secretBytes = new TextEncoder().encode("secret-file-bytes");

  function files(): OimFilePort {
    return {
      content: async () => ({
        file: {
          id: "file-1",
          filename: "report.pdf",
          mediaType: "application/pdf",
          sizeBytes: secretBytes.byteLength,
        },
        body: (async function* () {
          yield secretBytes;
        })(),
      }),
      store: async ({ body }) => {
        let sizeBytes = 0;
        for await (const chunk of body) sizeBytes += chunk.byteLength;
        return {
          id: "file-export",
          filename: "export.pdf",
          mediaType: "application/pdf",
          sizeBytes,
        };
      },
    };
  }

  it("streams an uploaded File without placing bytes in Tool arguments or results", async () => {
    const http = new RecordingHttp({ status: 200, headers: {}, body: { uploaded: true } });
    const assertAuthorized = vi.fn(async () => {});
    const adapter = new OimHttpToolAdapter({
      http,
      files: files(),
      fileReadAuthorization: { assertAuthorized },
      binding: {
        method: "POST",
        baseUrl: "https://api.weather.example",
        pathTemplate: "/upload",
        mutating: true,
        params: [],
        hasBody: true,
        headers: {},
        contentType: "multipart",
        multipart: [{ name: "file", kind: "file", pointer: "/fileId" }],
      },
    });
    const base = request({ body: { fileId: "file-1" } });
    const input = { ...base, intent: { ...base.intent, filePrincipalId: "user-1" } };

    const output = await adapter.dispatch(input);

    expect(output).toEqual({ uploaded: true });
    expect(http.sent[0]?.multipart?.[0]).toMatchObject({
      name: "file",
      filename: "report.pdf",
      mediaType: "application/pdf",
    });
    expect(JSON.stringify(input.intent.arguments)).toBe('{"body":{"fileId":"file-1"}}');
    expect(JSON.stringify(output)).not.toContain("secret-file-bytes");
    expect(
      JSON.stringify({ toolArguments: input.intent.arguments, toolResult: output })
    ).not.toContain("secret-file-bytes");
    expect(assertAuthorized).toHaveBeenCalledWith({
      request: input,
      fileIds: ["file-1"],
    });
  });

  it("denies undeclared File authority before opening content or sending HTTP", async () => {
    const http = new RecordingHttp({ status: 200, headers: {}, body: { uploaded: true } });
    const content = vi.fn<OimFilePort["content"]>();
    const adapter = new OimHttpToolAdapter({
      http,
      files: {
        content,
        store: files().store,
      },
      fileReadAuthorization: {
        assertAuthorized: async () => {
          throw new Error("denied");
        },
      },
      binding: {
        method: "POST",
        baseUrl: "https://api.weather.example",
        pathTemplate: "/upload",
        mutating: true,
        params: [],
        hasBody: true,
        headers: {},
        contentType: "multipart",
        multipart: [{ name: "upload", kind: "file", pointer: "/arbitrary/nested/blob" }],
      },
    });
    const base = request({ body: { arbitrary: { nested: { blob: "file-1" } } } });
    const input = { ...base, intent: { ...base.intent, filePrincipalId: "user-1" } };

    await expect(adapter.dispatch(input)).rejects.toMatchObject({
      phase: "before_dispatch",
      code: "file_authorization_denied",
      retryable: false,
    });
    expect(content).not.toHaveBeenCalled();
    expect(http.sent).toHaveLength(0);
  });

  it("requires a host File authorization port before opening content", async () => {
    const http = new RecordingHttp({ status: 200, headers: {}, body: { uploaded: true } });
    const content = vi.fn<OimFilePort["content"]>();
    const adapter = new OimHttpToolAdapter({
      http,
      files: {
        content,
        store: files().store,
      },
      binding: {
        method: "POST",
        baseUrl: "https://api.weather.example",
        pathTemplate: "/upload",
        mutating: true,
        params: [],
        hasBody: true,
        headers: {},
        contentType: "multipart",
        multipart: [{ name: "upload", kind: "file", pointer: "/attachment" }],
      },
    });
    const base = request({ body: { attachment: "file-1" } });
    const input = { ...base, intent: { ...base.intent, filePrincipalId: "user-1" } };

    await expect(adapter.dispatch(input)).rejects.toMatchObject({
      phase: "before_dispatch",
      code: "file_authorization_missing",
      retryable: false,
    });
    expect(content).not.toHaveBeenCalled();
    expect(http.sent).toHaveLength(0);
  });

  it("does not send HTTP when the authorized File port denies the read", async () => {
    const http = new RecordingHttp({ status: 200, headers: {}, body: { uploaded: true } });
    const content = vi.fn<OimFilePort["content"]>(async () => {
      throw new Error("File not found");
    });
    const adapter = new OimHttpToolAdapter({
      http,
      files: {
        content,
        store: files().store,
      },
      fileReadAuthorization: { assertAuthorized: async () => {} },
      binding: {
        method: "POST",
        baseUrl: "https://api.weather.example",
        pathTemplate: "/upload",
        mutating: true,
        params: [],
        hasBody: true,
        headers: {},
        contentType: "multipart",
        multipart: [{ name: "upload", kind: "file", pointer: "/attachment" }],
      },
    });
    const base = request({ body: { attachment: "file-1" } });
    const input = { ...base, intent: { ...base.intent, filePrincipalId: "user-1" } };

    await expect(adapter.dispatch(input)).rejects.toMatchObject({
      phase: "before_dispatch",
      code: "file_access_denied",
      retryable: false,
    });
    expect(content).toHaveBeenCalledOnce();
    expect(http.sent).toHaveLength(0);
  });

  it("rejects every invalid declared File ID before authorization or transport", async () => {
    const http = new RecordingHttp({ status: 200, headers: {}, body: { uploaded: true } });
    const content = vi.fn<OimFilePort["content"]>();
    const assertAuthorized = vi.fn(async () => {});
    const adapter = new OimHttpToolAdapter({
      http,
      files: {
        content,
        store: files().store,
      },
      fileReadAuthorization: { assertAuthorized },
      binding: {
        method: "POST",
        baseUrl: "https://api.weather.example",
        pathTemplate: "/upload",
        mutating: true,
        params: [],
        hasBody: true,
        headers: {},
        contentType: "multipart",
        multipart: [
          { name: "first", kind: "file", pointer: "/uploads/first/id" },
          { name: "second", kind: "file", pointer: "/uploads/second/id" },
        ],
      },
    });
    const base = request({
      body: { uploads: { first: { id: "file-1" }, second: { id: 42 } } },
    });
    const input = { ...base, intent: { ...base.intent, filePrincipalId: "user-1" } };

    await expect(adapter.dispatch(input)).rejects.toMatchObject({
      phase: "before_dispatch",
      code: "invalid_arguments",
      retryable: false,
    });
    expect(assertAuthorized).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
    expect(http.sent).toHaveLength(0);
  });

  it("stores an over-limit binary response and returns only File provenance", async () => {
    const http = new RecordingHttp({
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="export.pdf"',
      },
      body: undefined,
    });
    http.send = async (sent) => {
      http.sent.push(sent);
      return {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="export.pdf"',
        },
        body: await sent.binaryResponse?.({
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="export.pdf"',
          },
          declaredBytes: 20,
          body: (async function* () {
            yield new Uint8Array(20);
          })(),
        }),
      };
    };
    const adapter = new OimHttpToolAdapter({
      http,
      files: files(),
      binding: {
        method: "GET",
        baseUrl: "https://api.weather.example",
        pathTemplate: "/export",
        mutating: false,
        params: [],
        hasBody: false,
        headers: {},
        maxResponseBytes: 8,
        binaryResponse: true,
      },
    });
    const base = request({});
    const input = { ...base, intent: { ...base.intent, filePrincipalId: "user-1" } };

    await expect(adapter.dispatch(input)).resolves.toEqual({
      fileId: "file-export",
      summary: {
        filename: "export.pdf",
        mediaType: "application/pdf",
        sizeBytes: 20,
        truncated: true,
      },
    });
  });
});
