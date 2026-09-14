import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type OimManifest, parseOimManifest } from "@tulipfarm/schema";
import type { ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import { GuardedEgressHttp } from "./destination";
import { FetchEgressHttp } from "./fetch-http";
import { OimHttpToolAdapter } from "./oim-http-adapter";
import { compileOimHttpOperations } from "./oim-http-compile";

const LIVE_SMOKE_ENV = "OIM_LIVE_PROVIDER_SMOKE";

interface LiveProviderSmoke {
  readonly id: string;
  readonly credentialSlots: readonly string[];
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly healthCheckOperationId: string;
  readonly readOperationId: string;
  readonly readArguments: Readonly<Record<string, unknown>>;
}

const LIVE_PROVIDERS: readonly LiveProviderSmoke[] = [
  {
    id: "openweather",
    credentialSlots: ["api_key"],
    configuration: {},
    healthCheckOperationId: "check-connection",
    readOperationId: "current-weather",
    readArguments: { q: "London,GB", units: "metric" },
  },
  {
    id: "trello",
    credentialSlots: ["api_key", "token"],
    configuration: {},
    healthCheckOperationId: "get-member",
    readOperationId: "list-boards",
    readArguments: { filter: "open" },
  },
  {
    id: "gitlab",
    credentialSlots: ["access_token"],
    configuration: { gitlab_host: "gitlab.com" },
    healthCheckOperationId: "current-user",
    readOperationId: "current-user",
    readArguments: {},
  },
];

function credentialEnvironmentName(providerId: string, slot: string): string {
  return `OIM_LIVE_${providerId.toUpperCase().replaceAll("-", "_")}_${slot.toUpperCase()}`;
}

function liveSmokeEnabled(value: string | undefined): boolean {
  return value === "1";
}

function configuredCredentials(
  provider: LiveProviderSmoke
): Readonly<Record<string, string>> | undefined {
  const credentials = Object.fromEntries(
    provider.credentialSlots.flatMap((slot) => {
      const value = process.env[credentialEnvironmentName(provider.id, slot)];
      return value === undefined || value.trim() === "" ? [] : [[slot, value]];
    })
  );
  return Object.keys(credentials).length === provider.credentialSlots.length
    ? credentials
    : undefined;
}

function missingCredentialEnvironmentNames(provider: LiveProviderSmoke): readonly string[] {
  return provider.credentialSlots
    .map((slot) => credentialEnvironmentName(provider.id, slot))
    .filter((name) => {
      const value = process.env[name];
      return value === undefined || value.trim() === "";
    });
}

function manifestFor(provider: LiveProviderSmoke): OimManifest {
  const path = resolve(__dirname, "../../../../integrations", provider.id, "oim.yml");
  return parseOimManifest(readFileSync(path, "utf8"));
}

function request(
  provider: LiveProviderSmoke,
  operationId: string,
  argumentsValue: Readonly<Record<string, unknown>>
): ToolAdapterRequest {
  return {
    intent: {
      intentId: `live-smoke-${provider.id}-${operationId}`,
      businessId: "live-smoke",
      runId: "live-smoke",
      stateId: "live-smoke",
      toolId: `live-smoke-${provider.id}-${operationId}`,
      toolVersion: "1.0.0",
      action: `integration.${provider.id}.${operationId}`,
      targetRefs: [],
      arguments: argumentsValue,
      idempotencyKey: `live-smoke-${provider.id}-${operationId}`,
    },
    idempotencyKey: `live-smoke-${provider.id}-${operationId}`,
    attempt: 1,
  };
}

async function dispatch(
  provider: LiveProviderSmoke,
  manifest: OimManifest,
  operationId: string,
  argumentsValue: Readonly<Record<string, unknown>>,
  credentials: Readonly<Record<string, string>>
): Promise<unknown> {
  const operation = compileOimHttpOperations(manifest, provider.configuration).find(
    (candidate) => candidate.operation.id === operationId
  );
  if (operation === undefined)
    throw new Error(`missing live smoke operation: ${provider.id}/${operationId}`);

  return new OimHttpToolAdapter({
    binding: operation.binding,
    manifest,
    projection: operation.projection,
    ...(operation.pagination === undefined ? {} : { pagination: operation.pagination }),
    http: new GuardedEgressHttp(new FetchEgressHttp({ timeoutMs: 15_000 })),
  }).dispatch(request(provider, operationId, argumentsValue), undefined, credentials);
}

describe("OIM live provider smoke safety", () => {
  it("requires an explicit opt-in", () => {
    expect(liveSmokeEnabled(undefined)).toBe(false);
    expect(liveSmokeEnabled("0")).toBe(false);
    expect(liveSmokeEnabled("1")).toBe(true);
  });
});

describe("OIM live provider smoke tests", () => {
  for (const provider of LIVE_PROVIDERS) {
    const credentials = configuredCredentials(provider);
    const missing = missingCredentialEnvironmentNames(provider);

    if (!liveSmokeEnabled(process.env[LIVE_SMOKE_ENV])) {
      it.skip(`${provider.id}: skipped until ${LIVE_SMOKE_ENV}=1 explicitly enables live requests`, () => {});
      continue;
    }

    if (credentials === undefined) {
      it.skip(`${provider.id}: skipped because ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} absent`, () => {});
      continue;
    }

    it(`${provider.id}: checks authenticated connection and one harmless read`, async () => {
      const manifest = manifestFor(provider);
      expect(manifest.auth?.healthCheckOperationId).toBe(provider.healthCheckOperationId);

      const healthCheck = await dispatch(
        provider,
        manifest,
        provider.healthCheckOperationId,
        {},
        credentials
      );
      expect(healthCheck).not.toBeUndefined();

      if (provider.readOperationId === provider.healthCheckOperationId) return;
      const read = await dispatch(
        provider,
        manifest,
        provider.readOperationId,
        provider.readArguments,
        credentials
      );
      expect(read).not.toBeUndefined();
    });
  }
});
