import type { StoredPublicOrigins } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import {
  normalizePublicOrigin,
  PublicOriginError,
  type PublicOriginRepository,
  PublicOriginsService,
} from "./public-origins";

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
