import { describe, expect, it, vi } from "vitest";
import {
  GovernedSlackFileUploadSource,
  SlackExternalUploadHttp,
  SlackIntegrationIdentityResolver,
} from "./ports";

describe("Slack Tool host ports", () => {
  it("resolves exactly one active Slack Integration", async () => {
    const resolver = new SlackIntegrationIdentityResolver({
      async loadProviderSnapshot() {
        return {
          apps: [],
          accessGrants: [],
          routes: [],
          integrations: [
            {
              id: "integration-1",
              businessId: "business-1",
              appId: "app-1",
              externalTenantId: "T1",
              status: "active" as const,
            },
          ],
        };
      },
    });
    await expect(resolver.resolve("business-1")).resolves.toBe("integration-1");
  });

  it("ignores revoked Slack Integrations when resolving ownership identity", async () => {
    const resolver = new SlackIntegrationIdentityResolver({
      async loadProviderSnapshot() {
        return {
          integrations: [
            { id: "integration-revoked", status: "revoked" },
            { id: "integration-active", status: "active" },
          ],
        };
      },
    });

    await expect(resolver.resolve("business-1")).resolves.toBe("integration-active");
  });

  it("authorizes File bytes through the Run's effective user", async () => {
    const content = vi.fn(async () => ({
      file: { filename: "report.txt", mediaType: "text/plain", sizeBytes: 3 },
      body: (async function* () {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3]);
      })(),
    }));
    const source = new GovernedSlackFileUploadSource(
      {
        async find() {
          return { identity: { effectiveSubject: { kind: "user", id: "user-1" } } };
        },
      },
      { content }
    );

    await expect(
      source.load({ businessId: "business-1", runId: "run-1", fileId: "file-1" })
    ).resolves.toEqual({
      filename: "report.txt",
      mediaType: "text/plain",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(content).toHaveBeenCalledWith("business-1", "file-1", "user-1");
  });

  it("rejects non-Slack upload URLs before sending bytes", async () => {
    const fetch = vi.fn();
    const upload = new SlackExternalUploadHttp(fetch);

    await expect(
      upload.upload("https://example.com/upload", new Uint8Array([1]), "text/plain")
    ).rejects.toThrow("slack_upload_url_rejected");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uploads bytes only to Slack's HTTPS upload host", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 200 }));
    const upload = new SlackExternalUploadHttp(fetch);

    await upload.upload(
      "https://files.slack.com/upload/v1/token",
      new Uint8Array([1, 2]),
      "text/plain"
    );

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://files.slack.com/upload/v1/token"),
      expect.objectContaining({ method: "POST", redirect: "error" })
    );
  });
});
