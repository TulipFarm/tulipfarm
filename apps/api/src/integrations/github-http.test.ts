import { GITHUB_TOOL_IDS, GitHubAdapter } from "@tulipfarm/integrations";
import { describe, expect, it, vi } from "vitest";
import { GitHubInstallHttp } from "./github-http";

describe("GitHub content URLs", () => {
  it.each([GITHUB_TOOL_IDS.contentRead, GITHUB_TOOL_IDS.contentList])(
    "%s preserves slashes and literal reserved bytes through the real transport",
    async (action) => {
      const path = "docs #?/literal%23%2F/notes#2026?.md";
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(JSON.stringify(action === GITHUB_TOOL_IDS.contentRead ? { path } : []), {
          status: 200,
        })
      );
      const adapter = new GitHubAdapter({
        http: new GitHubInstallHttp({ fetch }),
        now: () => new Date("2026-09-17"),
        context: {
          resolve: async () => ({
            integrationId: "github",
            installation: {
              businessId: "business",
              integrationId: "github",
              installationId: "1",
              accountLogin: "tulip",
              repositories: ["tulip/farm"],
              permissions: { contents: "read" },
            },
            principals: [{ kind: "agent", id: "agent" }],
            grants: [
              {
                apiVersion: "tulipfarm.ai/v1",
                kind: "AccessGrant",
                metadata: {
                  id: "grant",
                  slug: "github-read",
                  schemaVersion: 1,
                  authoredVersion: 1,
                  lifecycle: "active",
                },
                spec: {
                  integrationId: "github",
                  principals: [{ kind: "agent", id: "agent" }],
                  actions: [action],
                  externalTargets: [{ type: "github.repository", ids: ["tulip/farm"] }],
                  delegable: false,
                },
              },
            ],
          }),
        },
      });
      await adapter.dispatch(
        {
          intent: {
            intentId: "intent",
            businessId: "business",
            runId: "run",
            stateId: "read",
            toolId: action,
            toolVersion: "1.0.0",
            action,
            targetRefs: [],
            arguments: { repository: "tulip/farm", path, ref: "feature/#?%" },
            destination: "github",
            credentialRef: "secret://fixture",
            idempotencyKey: "key",
          },
          idempotencyKey: "key",
          attempt: 1,
        },
        "fixture-token"
      );
      const url = new URL(String(fetch.mock.calls[0]?.[0]));
      expect(url.pathname).toBe(
        "/repos/tulip/farm/contents/docs%20%23%3F/literal%2523%252F/notes%232026%3F.md"
      );
      expect(url.hash).toBe("");
      expect([...url.searchParams]).toEqual([["ref", "feature/#?%"]]);
      expect(url.pathname.split("/").slice(5).map(decodeURIComponent).join("/")).toBe(path);
    }
  );
});
