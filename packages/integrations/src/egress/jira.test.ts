import { readFile } from "node:fs/promises";
import { ajv, parseOimFixtureSuite, parseOimManifest } from "@tulipfarm/schema";
import { type ToolAdapterRequest, ToolBroker, ToolCatalog } from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import { FetchEgressHttp } from "./fetch-http";
import { OimHttpToolAdapter } from "./oim-http-adapter";
import { compileOimHttpOperations } from "./oim-http-compile";
import type { OpenApiOperationBinding } from "./openapi-compile";

const packageRoot = new URL("../../../../integrations/jira/", import.meta.url);

async function operation(id: string) {
  const manifest = parseOimManifest(await readFile(new URL("oim.yml", packageRoot), "utf8"));
  const compiled = compileOimHttpOperations(manifest, {
    jira_site: "example.atlassian.net",
  }).find((entry) => entry.operation.id === id);
  if (compiled === undefined) throw new Error(`Missing Jira operation ${id}`);
  return compiled;
}

function request(toolId: string, args: Record<string, unknown>): ToolAdapterRequest {
  return {
    intent: {
      intentId: "intent-1",
      businessId: "business-1",
      runId: "run-1",
      stateId: "state-1",
      toolId,
      toolVersion: "1.1.0",
      action: "integration.jira.test",
      targetRefs: [],
      arguments: args,
      idempotencyKey: "effect-1",
    },
    idempotencyKey: "effect-1",
    attempt: 1,
  };
}

describe("Jira provider wire responses", () => {
  it.each([
    ["update-issue", "PUT", { fields: { priority: { id: "2" } } }],
    ["transition-issue", "POST", { transition: { id: "31" } }],
  ])("accepts a real FetchEgressHttp 204 for %s as exactly null", async (id, method, body) => {
    const compiled = await operation(id);
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const adapter = new OimHttpToolAdapter({
      binding: compiled.binding,
      http: new FetchEgressHttp({ fetch }),
    });

    await expect(
      adapter.dispatch(
        request(compiled.toolId, { issueIdOrKey: "ENG-41", body }),
        "muskan@example.com:fixture-token"
      )
    ).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([
      expect.stringContaining("/rest/api/3/issue/ENG-41"),
      expect.objectContaining({ method, body: JSON.stringify(body) }),
    ]);
    expect(ajv.compile(compiled.contract.spec.outputSchema)(null)).toBe(true);
    expect(compiled.contract.spec.idempotency.strategy).toBe("reconcile");
    expect(compiled.contract.spec.retry).toEqual({ maxAttempts: 3, safeToRetry: true });
  });

  it.each([
    ["empty 200", null],
    ["object 200", "{}"],
    ["malformed JSON 200", "{broken"],
  ])("does not normalize %s into mutation success", async (_name, body) => {
    const compiled = await operation("update-issue");
    const adapter = new OimHttpToolAdapter({
      binding: compiled.binding,
      http: new FetchEgressHttp({
        fetch: async () =>
          new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      }),
    });
    await expect(
      adapter.dispatch(
        request(compiled.toolId, { issueIdOrKey: "ENG-41", body: { fields: {} } }),
        "fixture:token"
      )
    ).rejects.toMatchObject({ phase: "after_dispatch", code: "invalid_output", retryable: false });
  });

  it.each([
    [400, "before_dispatch", "provider_error", false],
    [401, "before_dispatch", "provider_unauthorized", false],
    [403, "before_dispatch", "provider_unauthorized", false],
    [404, "before_dispatch", "provider_not_found", false],
    [409, "before_dispatch", "provider_conflict", false],
    [429, "before_dispatch", "provider_rate_limited", true],
    [500, "after_dispatch", "provider_unavailable", true],
  ])(
    "preserves the failure phase and retry semantics for HTTP %i",
    async (status, phase, code, retryable) => {
      const compiled = await operation("transition-issue");
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ errorMessages: ["Provider rejected the request"], errors: {} }),
            {
              status,
              headers: { "content-type": "application/json", "retry-after": "2" },
            }
          )
      );
      const adapter = new OimHttpToolAdapter({
        binding: compiled.binding,
        http: new FetchEgressHttp({ fetch }),
      });
      await expect(
        adapter.dispatch(
          request(compiled.toolId, { issueIdOrKey: "ENG-41", body: { transition: { id: "31" } } }),
          "fixture:token"
        )
      ).rejects.toMatchObject({
        phase,
        code,
        retryable,
        ...(status === 429 ? { retryAfterMs: 2000 } : {}),
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it("preserves ambiguity when a mutation's transport fails", async () => {
    const compiled = await operation("update-issue");
    const fetch = vi.fn(async (): Promise<Response> => {
      throw new TypeError("connection lost");
    });
    const adapter = new OimHttpToolAdapter({
      binding: compiled.binding,
      http: new FetchEgressHttp({ fetch }),
    });
    await expect(
      adapter.dispatch(
        request(compiled.toolId, { issueIdOrKey: "ENG-41", body: { fields: {} } }),
        "fixture:token"
      )
    ).rejects.toMatchObject({
      phase: "after_dispatch",
      code: "provider_unavailable",
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("explicit no-content output contract", () => {
  const binding: OpenApiOperationBinding = {
    method: "PUT",
    baseUrl: "https://example.atlassian.net",
    pathTemplate: "/issue",
    mutating: true,
    hasBody: false,
    headers: {},
    params: [],
  };

  it.each([
    ["object contract", { type: "object" }, undefined],
    ["nullable object contract", { type: ["object", "null"] }, undefined],
    ["impossible 204 object body", { type: "null" }, {}],
    ["schema constraints still fail", { type: "null", not: { const: null } }, undefined],
  ])("does not swallow validation errors for %s", async (_name, responseSchema, body) => {
    const adapter = new OimHttpToolAdapter({
      binding: { ...binding, responseSchema },
      http: { send: async () => ({ status: 204, headers: {}, body }) },
    });
    await expect(adapter.dispatch(request("test", {}))).rejects.toMatchObject({
      phase: "after_dispatch",
      code: "invalid_output",
      retryable: false,
    });
  });
});

describe("Jira metadata and explicit offset pages", () => {
  it("fails rather than implying a complete result when pagination metadata is missing", async () => {
    const compiled = await operation("list-issue-changelog");
    const adapter = new OimHttpToolAdapter({
      binding: compiled.binding,
      http: new FetchEgressHttp({
        fetch: async () => Response.json({ values: [], startAt: 0, maxResults: 50 }),
      }),
    });
    await expect(
      adapter.dispatch(request(compiled.toolId, { issueIdOrKey: "ENG-41" }), "fixture:token")
    ).rejects.toMatchObject({ phase: "after_dispatch", code: "invalid_output" });
  });

  it.each([
    ["list-projects", "values", {}],
    ["list-create-issue-types", "issueTypes", { projectIdOrKey: "ENG" }],
    ["list-create-fields", "fields", { projectIdOrKey: "ENG", issueTypeId: "10001" }],
    ["list-issue-comments", "comments", { issueIdOrKey: "ENG-41" }],
    ["list-issue-changelog", "values", { issueIdOrKey: "ENG-41" }],
  ])(
    "reads subsequent and empty pages for %s with provider-shaped JSON",
    async (id, itemsKey, args) => {
      const compiled = await operation(id);
      const suite = parseOimFixtureSuite(
        await readFile(new URL("fixtures.yml", packageRoot), "utf8")
      );
      const fixture = suite.cases.find((entry) => entry.operationId === id);
      if (fixture === undefined) throw new Error(`Missing fixture for ${id}`);
      const providerBody = fixture.response.body as Record<string, unknown>;
      const fetch = vi.fn(async (url: string) => {
        const offset = Number(new URL(url).searchParams.get("startAt"));
        return Response.json({
          ...providerBody,
          startAt: offset,
          maxResults: 1,
          total: 2,
          isLast: offset >= 1,
          [itemsKey]: offset < 2 ? providerBody[itemsKey] : [],
        });
      });
      const adapter = new OimHttpToolAdapter({
        binding: compiled.binding,
        projection: compiled.projection,
        http: new FetchEgressHttp({ fetch }),
      });
      for (const startAt of [0, 1, 2]) {
        const result = await adapter.dispatch(
          request(compiled.toolId, { ...args, startAt, maxResults: 1 }),
          "fixture:token"
        );
        expect(result).toMatchObject({
          startAt,
          total: 2,
          [itemsKey]: startAt < 2 ? providerBody[itemsKey] : [],
        });
      }
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(compiled.contract.spec.riskClass).toBe("low");
      expect(compiled.contract.spec.mutating).toBe(false);
    }
  );

  it("rejects invalid offset/size arguments at the Tool authorization boundary", async () => {
    const compiled = await operation("list-issue-comments");
    const broker = new ToolBroker(ToolCatalog.load([compiled.contract]));
    for (const invalid of [
      { startAt: -1 },
      { startAt: 0.5 },
      { maxResults: 0 },
      { maxResults: 101 },
    ]) {
      const invocation = request(compiled.toolId, { issueIdOrKey: "ENG-41", ...invalid });
      await expect(
        broker.authorize(
          { ...invocation.intent, action: compiled.contract.spec.action },
          {
            authorityLayers: [],
            guardrailRules: [],
            dlpRules: [],
            guardrailRevision: "fixture",
            taint: "trusted",
          }
        )
      ).toMatchObject({ outcome: "denied", reason: "invalid_arguments" });
    }
  });

  it("keeps all operations within the site's Basic-auth Cloud boundary", async () => {
    const manifest = parseOimManifest(await readFile(new URL("oim.yml", packageRoot), "utf8"));
    const compiled = compileOimHttpOperations(manifest, { jira_site: "example.atlassian.net" });
    expect(compiled).toHaveLength(14);
    for (const tool of compiled) {
      expect(tool.binding.baseUrl).toBe("https://example.atlassian.net");
      expect(tool.binding.auth).toMatchObject({
        in: "header",
        header: "Authorization",
        format: "Basic {token}",
        encoding: "basic",
        credentialSlot: "api_credential",
      });
    }
    for (const jira_site of ["api.atlassian.com", "jira.example.com"]) {
      expect(() => compileOimHttpOperations(manifest, { jira_site })).toThrow();
    }
  });
});
