import type { OimManifest, OimOperation } from "@tulipfarm/schema";
import { AdapterDispatchError, type ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import {
  OIM_MAX_RETRY_AFTER_MS,
  type OimRateLimitAdmissionPort,
  OimRateLimitedToolAdapter,
  oimRateLimitScope,
  parseOimRetryAfterMs,
} from "./oim-rate-limit";

const NOW = new Date("2026-09-07T06:30:00.000Z");
const manifest = {
  metadata: { id: "weather", version: "2.4.1" },
} as OimManifest;
const operation = {
  id: "forecast",
  credentialSlot: "api_key",
  source: {
    type: "http",
    method: "GET",
    baseUrl: "https://api.weather.example",
    path: "/forecast",
  },
  rateLimit: { requests: 1, perSeconds: 60, scope: "operation" },
} as OimOperation;
const request = {
  attempt: 1,
  idempotencyKey: "stable-key",
  intent: {
    intentId: "intent-1",
    businessId: "business-1",
    runId: "run-1",
    stateId: "state-1",
    toolId: "integration.weather.forecast",
    toolVersion: "2.4.1",
    action: "integration.weather.forecast",
    targetRefs: [],
    arguments: {},
    credentialRef: "secret://weather",
    destination: "api.weather.example",
    connection: {
      connectionId: "connection-7",
      integrationId: "weather",
      credentialSlot: "api_key",
    },
    idempotencyKey: "stable-key",
  },
} satisfies ToolAdapterRequest;

describe("OIM rate limit helpers", () => {
  it("builds a tenant, Integration-major, Connection, and operation scope", () => {
    expect(oimRateLimitScope(manifest, operation, request)).toEqual({
      businessId: "business-1",
      integrationId: "weather",
      integrationMajorVersion: 2,
      connectionId: "connection-7",
      scope: "operation",
      operationId: "forecast",
    });
  });

  it("builds an anonymous operation scope for a fixed credential-free public operation", () => {
    const publicOperation = {
      ...operation,
      credentialSlot: undefined,
      source: {
        type: "http",
        method: "GET",
        baseUrl: "https://api.weather.example",
        path: "/forecast",
      },
    } as OimOperation;
    const publicRequest = {
      ...request,
      intent: {
        ...request.intent,
        credentialRef: undefined,
        connection: undefined,
      },
    } satisfies ToolAdapterRequest;

    expect(oimRateLimitScope(manifest, publicOperation, publicRequest)).toEqual({
      businessId: "business-1",
      integrationId: "weather",
      integrationMajorVersion: 2,
      scope: "operation",
      operationId: "forecast",
    });
  });

  it("requires a Connection for credentialed or tenant-configured operations", () => {
    const withoutConnection = {
      ...request,
      intent: { ...request.intent, connection: undefined },
    } satisfies ToolAdapterRequest;
    const configuredOperation = {
      ...operation,
      credentialSlot: undefined,
      source: {
        type: "http",
        method: "GET",
        baseUrl: "https://{site}.weather.example",
        path: "/forecast",
      },
    } as OimOperation;

    expect(() => oimRateLimitScope(manifest, operation, withoutConnection)).toThrowError(
      expect.objectContaining({ code: "rate_limit_scope_missing" })
    );
    expect(() => oimRateLimitScope(manifest, configuredOperation, withoutConnection)).toThrowError(
      expect.objectContaining({ code: "rate_limit_scope_missing" })
    );
  });

  it("requires a Connection for a configuration-only OpenAPI base URL", () => {
    const configuredOperation = {
      ...operation,
      credentialSlot: undefined,
      source: {
        type: "openapi",
        file: "openapi.yaml",
        operationId: "getForecast",
        baseUrl: "https://{site}.weather.example",
      },
    } as OimOperation;
    const withoutConnection = {
      ...request,
      intent: {
        ...request.intent,
        credentialRef: undefined,
        connection: undefined,
      },
    } satisfies ToolAdapterRequest;

    expect(() => oimRateLimitScope(manifest, configuredOperation, withoutConnection)).toThrowError(
      expect.objectContaining({ code: "rate_limit_scope_missing" })
    );
  });

  it("parses bounded Retry-After seconds and HTTP dates", () => {
    expect(parseOimRetryAfterMs({ "retry-after": "45" }, NOW)).toBe(45_000);
    expect(
      parseOimRetryAfterMs({ "X-Rate-Reset": "Mon, 07 Sep 2026 06:30:20 GMT" }, NOW, "X-Rate-Reset")
    ).toBe(20_000);
    expect(parseOimRetryAfterMs({ "retry-after": "3600" }, NOW)).toBe(OIM_MAX_RETRY_AFTER_MS);
  });

  it("rejects malformed, negative, fractional, and past Retry-After values", () => {
    expect(parseOimRetryAfterMs({ "retry-after": "-1" }, NOW)).toBeUndefined();
    expect(parseOimRetryAfterMs({ "retry-after": "1.5" }, NOW)).toBeUndefined();
    expect(parseOimRetryAfterMs({ "retry-after": "not-a-date" }, NOW)).toBeUndefined();
    expect(
      parseOimRetryAfterMs({ "retry-after": "Mon, 07 Sep 2026 06:29:59 GMT" }, NOW)
    ).toBeUndefined();
  });

  it("does not dispatch a mutation twice while a shared provider cooldown is active", async () => {
    let cooldownUntil = 0;
    const limits: OimRateLimitAdmissionPort = {
      admit: vi.fn(async ({ now }) => {
        if (now.getTime() < cooldownUntil) {
          return {
            outcome: "limited" as const,
            retryAt: new Date(cooldownUntil).toISOString(),
          };
        }
        return { outcome: "admitted" as const };
      }),
      imposeCooldown: vi.fn(async ({ retryAt }) => {
        cooldownUntil = retryAt.getTime();
      }),
    };
    const delegate = {
      kind: "native" as const,
      dispatch: vi.fn(async () => {
        throw new AdapterDispatchError(
          "before_dispatch",
          "provider_rate_limited",
          true,
          undefined,
          30_000
        );
      }),
    };
    const adapter = new OimRateLimitedToolAdapter({
      delegate,
      manifest,
      operation,
      limits,
      now: () => NOW,
    });

    await expect(adapter.dispatch(request, "credential")).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryAfterMs: 30_000,
    });
    await expect(adapter.dispatch(request, "credential")).rejects.toMatchObject({
      code: "oim_rate_limited",
      retryAfterMs: 30_000,
    });
    expect(delegate.dispatch).toHaveBeenCalledTimes(1);
  });

  it("shares provider Retry-After cooldown when no fixed quota is declared", async () => {
    let cooldownUntil = 0;
    const limits: OimRateLimitAdmissionPort = {
      admit: vi.fn(async ({ now, quota }) => {
        expect(quota).toBeUndefined();
        return now.getTime() < cooldownUntil
          ? {
              outcome: "limited" as const,
              retryAt: new Date(cooldownUntil).toISOString(),
            }
          : { outcome: "admitted" as const };
      }),
      imposeCooldown: vi.fn(async ({ retryAt }) => {
        cooldownUntil = retryAt.getTime();
      }),
    };
    const delegate = {
      kind: "native" as const,
      dispatch: vi.fn(async () => {
        throw new AdapterDispatchError(
          "before_dispatch",
          "provider_rate_limited",
          true,
          undefined,
          20_000
        );
      }),
    };
    const adapter = new OimRateLimitedToolAdapter({
      delegate,
      manifest,
      operation: { ...operation, rateLimit: undefined },
      limits,
      now: () => NOW,
    });

    await expect(adapter.dispatch(request, "credential")).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryAfterMs: 20_000,
    });
    await expect(adapter.dispatch(request, "credential")).rejects.toMatchObject({
      code: "oim_rate_limited",
      retryAfterMs: 20_000,
    });
    expect(delegate.dispatch).toHaveBeenCalledTimes(1);
  });

  it("starts provider Retry-After at the response time", async () => {
    let clock = NOW;
    const imposeCooldown = vi.fn(async () => {});
    const adapter = new OimRateLimitedToolAdapter({
      delegate: {
        kind: "native",
        dispatch: async () => {
          clock = new Date("2026-09-07T06:30:05.000Z");
          throw new AdapterDispatchError(
            "before_dispatch",
            "provider_rate_limited",
            true,
            undefined,
            20_000
          );
        },
      },
      manifest,
      operation,
      limits: {
        admit: async () => ({ outcome: "admitted" }),
        imposeCooldown,
      },
      now: () => clock,
    });

    await expect(adapter.dispatch(request, "credential")).rejects.toMatchObject({
      code: "provider_rate_limited",
    });
    expect(imposeCooldown).toHaveBeenCalledWith({
      scope: expect.any(Object),
      retryAt: new Date("2026-09-07T06:30:25.000Z"),
      now: new Date("2026-09-07T06:30:05.000Z"),
    });
  });

  it("fails before dispatch when shared admission is unavailable", async () => {
    const delegate = {
      kind: "native" as const,
      dispatch: vi.fn(async () => ({ ok: true })),
    };
    const adapter = new OimRateLimitedToolAdapter({
      delegate,
      manifest,
      operation,
      limits: {
        admit: async () => {
          throw new Error("database unavailable");
        },
        imposeCooldown: async () => {},
      },
    });

    await expect(adapter.dispatch(request, "credential")).rejects.toMatchObject({
      phase: "before_dispatch",
      code: "rate_limit_store_unavailable",
      retryable: false,
    });
    expect(delegate.dispatch).not.toHaveBeenCalled();
  });
});
