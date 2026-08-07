import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { IntegrationHttpRequest, IntegrationHttpResponse } from "../http";
import { GitHubCredentialError, mintInstallationToken, signAppJwt } from "./credentials";

let privateKeyPem: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
});

function fakeHttp(handler: (request: IntegrationHttpRequest) => IntegrationHttpResponse) {
  return {
    async send(request: IntegrationHttpRequest) {
      return handler(request);
    },
  };
}

describe("signAppJwt", () => {
  it("produces a well-formed RS256 JWT with iss/iat/exp", () => {
    const now = () => new Date("2026-08-06T12:00:00.000Z");
    const jwt = signAppJwt("app-123", privateKeyPem, now);
    const [headerB64, payloadB64, signatureB64] = jwt.split(".");
    expect(headerB64).toBeDefined();
    expect(payloadB64).toBeDefined();
    expect(signatureB64).toBeDefined();

    const header = JSON.parse(Buffer.from(headerB64 as string, "base64url").toString());
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const payload = JSON.parse(Buffer.from(payloadB64 as string, "base64url").toString());
    expect(payload.iss).toBe("app-123");
    const nowSeconds = Math.floor(now().getTime() / 1000);
    expect(payload.iat).toBeLessThan(nowSeconds);
    expect(payload.exp).toBeGreaterThan(nowSeconds);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(10 * 60);
  });

  it("throws GitHubCredentialError on a malformed private key", () => {
    expect(() => signAppJwt("app-123", "not-a-key")).toThrow(GitHubCredentialError);
  });
});

describe("mintInstallationToken", () => {
  it("returns the token and expiry on a 201", async () => {
    const http = fakeHttp((request) => {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/app/installations/inst-1/access_tokens");
      return {
        status: 201,
        headers: {},
        body: { token: "ghs_abc123", expires_at: "2026-08-06T13:00:00Z" },
      };
    });

    const result = await mintInstallationToken(http, "app-jwt", "inst-1");
    expect(result.token).toBe("ghs_abc123");
    expect(result.expiresAt.toISOString()).toBe("2026-08-06T13:00:00.000Z");
  });

  it("throws installation_not_found on a 404", async () => {
    const http = fakeHttp(() => ({ status: 404, headers: {}, body: {} }));
    await expect(mintInstallationToken(http, "app-jwt", "inst-missing")).rejects.toMatchObject({
      reason: "installation_not_found",
    });
  });

  it("throws token_exchange_failed on a 5xx, never a stale/guessed value", async () => {
    const http = fakeHttp(() => ({ status: 503, headers: {}, body: {} }));
    await expect(mintInstallationToken(http, "app-jwt", "inst-1")).rejects.toMatchObject({
      reason: "token_exchange_failed",
    });
  });

  it("throws token_exchange_failed when the response body is malformed", async () => {
    const http = fakeHttp(() => ({ status: 200, headers: {}, body: { nope: true } }));
    await expect(mintInstallationToken(http, "app-jwt", "inst-1")).rejects.toMatchObject({
      reason: "token_exchange_failed",
    });
  });
});
