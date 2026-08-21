import type { SecretsService } from "@tulipfarm/secrets";
import type { AuthOAuth2Step } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_ACCESS_TOKEN_SECRET_REF,
  GoogleAccessTokenProvider,
  type GoogleConnection,
} from "./credentials";

const STEP: AuthOAuth2Step = {
  kind: "oauth2",
  authorization_url: "https://accounts.google.com/o/oauth2/v2/auth",
  token_url: "https://oauth2.googleapis.com/token",
  client_id_env: "GOOGLE_CLIENT_ID",
  client_secret_env: "GOOGLE_CLIENT_SECRET",
  token_env: "GOOGLE_ACCESS_TOKEN",
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
};

function ref(name: string): string {
  return `secret://integration.google.${name}`;
}

/** Map-backed secrets store exposing just the `get`/`set` the provider and env resolver use. */
function fakeSecrets(seed: Record<string, string>): {
  service: SecretsService;
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(seed));
  const service = {
    get: async (key: string) => {
      const value = store.get(key);
      if (value === undefined) throw new Error(`no secret ${key}`);
      return value;
    },
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    // biome-ignore lint/suspicious/noExplicitAny: only get/set are exercised
  } as any as SecretsService;
  return { service, store };
}

function connectionEnv(expiresAt: string): Record<string, string> {
  return {
    GOOGLE_CLIENT_ID: "client-123",
    GOOGLE_CLIENT_SECRET: ref("GOOGLE_CLIENT_SECRET"),
    GOOGLE_ACCESS_TOKEN: ref("GOOGLE_ACCESS_TOKEN"),
    GOOGLE_ACCESS_TOKEN_REFRESH_TOKEN: ref("GOOGLE_ACCESS_TOKEN_REFRESH_TOKEN"),
    GOOGLE_ACCESS_TOKEN_EXPIRES_AT: expiresAt,
  };
}

const SEALED = {
  "integration.google.GOOGLE_CLIENT_SECRET": "client-secret",
  "integration.google.GOOGLE_ACCESS_TOKEN": "old-token",
  "integration.google.GOOGLE_ACCESS_TOKEN_REFRESH_TOKEN": "refresh-abc",
};

function tokenResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  } as Response;
}

const NOW = new Date("2026-03-01T12:00:00Z");

describe("GoogleAccessTokenProvider", () => {
  it("ignores any secret ref other than the Google access token", async () => {
    const { service } = fakeSecrets({});
    const provider = new GoogleAccessTokenProvider({ secrets: async () => service });
    expect(await provider.resolveCurrent("secret://something/else")).toBeNull();
  });

  it("serves the stored token without refreshing while it is comfortably before expiry", async () => {
    const fetchImpl = vi.fn();
    const { service } = fakeSecrets(SEALED);
    const provider = new GoogleAccessTokenProvider({
      secrets: async () => service,
      connection: async (): Promise<GoogleConnection> => ({
        step: STEP,
        env: connectionEnv("2026-03-01T13:00:00Z"),
      }),
      now: () => NOW,
      fetchImpl: fetchImpl as never,
    });

    const lease = await provider.resolveCurrent(GOOGLE_ACCESS_TOKEN_SECRET_REF);
    expect(lease).toEqual({ value: "old-token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes within the skew window and persists the rotated token and expiry", async () => {
    const fetchImpl = vi.fn(async () =>
      tokenResponse(200, { access_token: "new-token", expires_in: 3600 })
    );
    const { service, store } = fakeSecrets(SEALED);
    const provider = new GoogleAccessTokenProvider({
      secrets: async () => service,
      connection: async (): Promise<GoogleConnection> => ({
        step: STEP,
        env: connectionEnv("2026-03-01T12:01:00Z"),
      }),
      now: () => NOW,
      fetchImpl: fetchImpl as never,
    });

    const lease = await provider.resolveCurrent(GOOGLE_ACCESS_TOKEN_SECRET_REF);
    expect(lease).toEqual({ value: "new-token" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.get("integration.google.GOOGLE_ACCESS_TOKEN")).toBe("new-token");
    expect(store.get("integration.google.GOOGLE_ACCESS_TOKEN_EXPIRES_AT")).toBe(
      new Date(NOW.getTime() + 3600 * 1000).toISOString()
    );
  });

  it("serves the stale token when the refresh call fails, so the API call surfaces the 401", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse(400, { error: "invalid_grant" }));
    const { service, store } = fakeSecrets(SEALED);
    const provider = new GoogleAccessTokenProvider({
      secrets: async () => service,
      connection: async (): Promise<GoogleConnection> => ({
        step: STEP,
        env: connectionEnv("2026-03-01T11:00:00Z"),
      }),
      now: () => NOW,
      fetchImpl: fetchImpl as never,
    });

    const lease = await provider.resolveCurrent(GOOGLE_ACCESS_TOKEN_SECRET_REF);
    expect(lease).toEqual({ value: "old-token" });
    expect(store.get("integration.google.GOOGLE_ACCESS_TOKEN")).toBe("old-token");
  });

  it("falls back to the stored token when no connection is available to refresh", async () => {
    const { service } = fakeSecrets(SEALED);
    const provider = new GoogleAccessTokenProvider({ secrets: async () => service });
    expect(await provider.resolveCurrent(GOOGLE_ACCESS_TOKEN_SECRET_REF)).toEqual({
      value: "old-token",
    });
  });

  it("resolves null when no Google token has been stored", async () => {
    const { service } = fakeSecrets({});
    const provider = new GoogleAccessTokenProvider({ secrets: async () => service });
    expect(await provider.resolveCurrent(GOOGLE_ACCESS_TOKEN_SECRET_REF)).toBeNull();
  });
});
