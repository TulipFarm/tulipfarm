import { generateKeyPairSync } from "node:crypto";
import type { EgressHttpPort, OimJwtAssertionRefreshRequest } from "@tulipfarm/integrations";
import { validateOimManifest } from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { refreshOimJwtAssertionStep } from "./oim-jwt";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

function request(): OimJwtAssertionRefreshRequest {
  const manifest = validateOimManifest({
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "google-service",
      name: "Google service",
      version: "1.0.0",
      description: "Service account API.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0" },
    auth: {
      credentialSlots: [
        { id: "issuer", label: "Issuer", kind: "client_secret" },
        { id: "private_key", label: "Private key", kind: "private_key" },
        { id: "access_token", label: "Access token", kind: "oauth2_access_token" },
      ],
      steps: [
        {
          id: "assertion",
          title: "Exchange assertion",
          type: "jwt_assertion",
          exchange: "oauth_jwt_bearer",
          tokenUrl: "https://oauth2.googleapis.com/token",
          issuer: { type: "credential", slot: "issuer" },
          privateKey: { type: "credential", slot: "private_key" },
          scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
          bindings: [
            {
              sourcePath: "/access_token",
              target: { type: "credential", slot: "access_token" },
            },
          ],
        },
      ],
    },
    operations: [
      {
        id: "read",
        name: "read",
        description: "Read data.",
        effect: "read",
        identityMode: "shared_only",
        credentialSlot: "access_token",
        credentialInjection: { in: "header", name: "authorization", format: "Bearer ******" },
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.example.test",
          path: "/",
        },
        response: { schema: { type: "object" }, maxBytes: 1_024 },
      },
    ],
  });
  const step = manifest.auth?.steps[0];
  if (step?.type !== "jwt_assertion") throw new Error("fixture");
  return {
    manifest,
    step,
    connection: {
      configuration: {},
    } as PersistedConnection,
    credentials: {
      issuer: "service@example.test",
      private_key: PRIVATE_KEY,
    },
  };
}

describe("refreshOimJwtAssertionStep", () => {
  it("mints a bounded RS256 assertion and returns only declared token bindings", async () => {
    const http: EgressHttpPort = {
      async send(sent) {
        expect(sent.url).toBe("https://oauth2.googleapis.com/token");
        const form = new URLSearchParams(sent.bodyText);
        expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
        const assertion = form.get("assertion");
        expect(assertion).not.toContain(PRIVATE_KEY);
        const payload = JSON.parse(
          Buffer.from(assertion?.split(".")[1] ?? "", "base64url").toString()
        );
        expect(payload).toMatchObject({
          iss: "service@example.test",
          aud: "https://oauth2.googleapis.com/token",
          scope: "https://www.googleapis.com/auth/calendar.readonly",
        });
        expect(payload.exp - payload.iat).toBeLessThanOrEqual(10 * 60);
        return {
          status: 200,
          headers: {},
          body: { access_token: "token", expires_in: 3600, ignored: "value" },
        };
      },
    };

    await expect(refreshOimJwtAssertionStep(request(), { http, now: NOW })).resolves.toEqual({
      credentialValues: { access_token: "token" },
      expiresAt: "2026-09-12T13:00:00.000Z",
    });
  });
});
