import { describe, expect, it } from "vitest";
import { AuthBrokerError } from "./errors";
import {
  ingressWebhookUrl,
  normalizePublicOrigin,
  PublicOriginError,
  type PublicOriginRepository,
  PublicOriginsService,
  type StoredPublicOrigins,
} from "./public-origins";

describe("ingressWebhookUrl", () => {
  const endpoints = {
    apiUrl: "https://api.tulip.example.com",
    webUrl: "https://tulip.example.com",
    callbackUrl: "https://api.tulip.example.com/api/v1/integrations/auth/callback",
  };

  it.each(["github", "slack"])("uses the fixed native endpoint for %s", (provider) => {
    const expected = `${endpoints.apiUrl}/api/v1/integrations/native/${provider}/events`;
    expect(ingressWebhookUrl(endpoints, provider)).toBe(expected);
    expect(ingressWebhookUrl({ ...endpoints, apiUrl: `${endpoints.apiUrl}///` }, provider)).toBe(
      expected
    );
  });

  it.each(["github-mcp", "slack-mcp", "google", "github/../slack", ""])(
    "refuses unsupported provider %j instead of returning a retired endpoint",
    (provider) => {
      expect(() => ingressWebhookUrl(endpoints, provider)).toThrow(AuthBrokerError);
      expect(() => ingressWebhookUrl(endpoints, provider)).toThrow(
        expect.objectContaining({ reason: "unknown_step", slug: provider })
      );
    }
  );
});

class MemoryPublicOrigins implements PublicOriginRepository {
  value: StoredPublicOrigins | null = null;

  async get(): Promise<StoredPublicOrigins | null> {
    return this.value;
  }

  async put(_businessId: string, origins: StoredPublicOrigins): Promise<void> {
    this.value = origins;
  }

  async delete(): Promise<void> {
    this.value = null;
  }
}

describe("normalizePublicOrigin", () => {
  it("normalizes an origin and rejects URL parts that cannot be public configuration", () => {
    expect(normalizePublicOrigin(" https://Tulip.Example.com:443/ ")).toBe(
      "https://tulip.example.com"
    );
    for (const invalid of [
      "ftp://tulip.example.com",
      "https://user:pass@tulip.example.com",
      "https://tulip.example.com/path",
      "https://tulip.example.com/?query=1",
      "not a url",
    ]) {
      expect(() => normalizePublicOrigin(invalid), invalid).toThrow(PublicOriginError);
    }
  });
});

describe("PublicOriginsService", () => {
  it("uses env as a fallback and a saved address without a restart", async () => {
    const repository = new MemoryPublicOrigins();
    const env = {
      PUBLIC_URL: "http://localhost:8085",
      PUBLIC_API_URL: "http://localhost:8085",
    } as NodeJS.ProcessEnv;
    const service = new PublicOriginsService(repository, "business-1", env);
    await service.initialize();
    expect(service.current()).toMatchObject({
      webOrigin: "http://localhost:8085",
      source: "environment",
    });

    await service.save({ webOrigin: "https://tulip.example.com" });
    expect(service.current()).toEqual({
      webOrigin: "https://tulip.example.com",
      apiOrigin: "https://tulip.example.com",
      callbackUrl: "https://tulip.example.com/api/v1/integrations/auth/callback",
      source: "database",
      locked: false,
      lockReason: null,
    });
    expect(env.PUBLIC_URL).toBe("https://tulip.example.com");

    await service.reset();
    expect(service.current().webOrigin).toBe("http://localhost:8085");
  });

  it("keeps an environment-managed deployment read-only", async () => {
    const repository = new MemoryPublicOrigins();
    repository.value = { webOrigin: "https://ignored.example.com", apiOrigin: null };
    const service = new PublicOriginsService(repository, "business-1", {
      PUBLIC_URL: "https://managed.example.com",
      PUBLIC_ORIGINS_LOCKED: "true",
    } as NodeJS.ProcessEnv);
    await service.initialize();

    expect(service.current()).toMatchObject({
      webOrigin: "https://managed.example.com",
      apiOrigin: "https://managed.example.com",
      source: "environment",
      locked: true,
    });
    await expect(service.save({ webOrigin: "https://other.example.com" })).rejects.toMatchObject({
      code: "environment_locked",
    });
  });
});
