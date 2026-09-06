import type { ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import type { IntegrationHttpResponse } from "../http";
import type { OimFilePort } from "./oim-files";
import { OimHttpToolAdapter } from "./oim-http-adapter";
import type { EgressHttpPort, EgressHttpRequest } from "./openapi-adapter";

class RecordingHttp implements EgressHttpPort {
  readonly sent: EgressHttpRequest[] = [];

  constructor(private readonly response: IntegrationHttpResponse) {}

  async send(request: EgressHttpRequest): Promise<IntegrationHttpResponse> {
    this.sent.push(request);
    return this.response;
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
      pagination: { type: "cursor", requestParameter: "cursor", responsePath: "/nextCursor" },
    });

    const output = (await adapter.dispatch(request({}))) as Record<string, unknown>;

    expect(output.values).toEqual([1, 2]);
    expect(typeof output.next_page_token).toBe("string");
    expect(output.next_page_token).not.toContain("provider-cursor-xyz");
  });

  it("resumes with the provider cursor the token stands for", async () => {
    const http = new RecordingHttp({ status: 200, headers: {}, body: { values: [] } });
    const adapter = new OimHttpToolAdapter({
      http,
      binding,
      toolId: "oim.weather.v1.readings",
      pagination: { type: "cursor", requestParameter: "cursor", responsePath: "/nextCursor" },
    });
    const token = Buffer.from(
      JSON.stringify({ v: 1, t: "oim.weather.v1.readings", k: "cursor", c: "page-2" }),
      "utf8"
    ).toString("base64url");

    await adapter.dispatch(request({ page_token: token }));

    expect(http.sent[0]?.url).toBe("https://api.weather.example/v1/readings?cursor=page-2");
  });

  it("refuses a page token minted for a different Tool instead of calling the provider", async () => {
    const http = new RecordingHttp({ status: 200, headers: {}, body: {} });
    const adapter = new OimHttpToolAdapter({
      http,
      binding,
      toolId: "oim.weather.v1.readings",
      pagination: { type: "cursor", requestParameter: "cursor", responsePath: "/nextCursor" },
    });
    const token = Buffer.from(
      JSON.stringify({ v: 1, t: "oim.other.v1.readings", k: "cursor", c: "page-2" }),
      "utf8"
    ).toString("base64url");

    await expect(adapter.dispatch(request({ page_token: token }))).rejects.toMatchObject({
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
      pagination: { type: "cursor", requestParameter: "cursor", responsePath: "/nextCursor" },
    });

    const output = (await adapter.dispatch(request({}))) as Record<string, unknown>;

    expect(output).not.toHaveProperty("next_page_token");
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
    const adapter = new OimHttpToolAdapter({
      http,
      files: files(),
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
