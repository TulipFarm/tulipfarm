import { describe, expect, it } from "vitest";
import { validateThirdPartyManifest } from "./integration-trust";
import type { IntegrationManifest } from "./types";

function manifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return { name: "acme", egress: { type: "none" }, ...overrides };
}

describe("validateThirdPartyManifest", () => {
  it("accepts a purely declarative manifest", () => {
    expect(validateThirdPartyManifest(manifest())).toEqual([]);
  });

  describe("code execution", () => {
    it("rejects ts-code egress", () => {
      const issues = validateThirdPartyManifest(
        manifest({ egress: { type: "ts-code", handler: "handler.ts", toolsSpec: "tools.json" } })
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain("ts-code");
    });

    it("rejects a stdio MCP server, which spawns a local process", () => {
      const issues = validateThirdPartyManifest(
        manifest({ egress: { type: "mcp", entry: { transport: "stdio", command: "npx" } } })
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain("stdio");
    });

    it("accepts an https sse MCP server, which is just a URL", () => {
      expect(
        validateThirdPartyManifest(
          manifest({
            egress: { type: "mcp", entry: { transport: "sse", url: "https://mcp.acme.com/sse" } },
          })
        )
      ).toEqual([]);
    });

    it("rejects an ingress handler module", () => {
      const issues = validateThirdPartyManifest(
        manifest({
          ingress: {
            handler: "classify.js",
            webhook: {
              security: { type: "hmac_sha256", header: "X-Sig", secret_env: "ACME_SECRET" },
            },
          },
        })
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain("ingress.handler");
    });

    it("reports every violation at once rather than stopping at the first", () => {
      const issues = validateThirdPartyManifest(
        manifest({
          egress: { type: "ts-code", handler: "h.ts", toolsSpec: "t.json" },
          ingress: {
            handler: "classify.js",
            webhook: {
              security: { type: "hmac_sha256", header: "X-Sig", secret_env: "ACME_SECRET" },
            },
          },
        })
      );
      expect(issues).toHaveLength(2);
    });
  });

  describe("transport security", () => {
    it("rejects a plaintext oauth2 token_url", () => {
      const issues = validateThirdPartyManifest(
        manifest({
          auth: [
            {
              kind: "oauth2",
              authorization_url: "https://acme.com/authorize",
              token_url: "http://acme.com/token",
              client_id_env: "ACME_CLIENT_ID",
              client_secret_env: "ACME_CLIENT_SECRET",
              token_env: "ACME_TOKEN",
            },
          ],
        })
      );
      expect(issues).toEqual([
        'auth.oauth2.token_url must be an https:// URL (got "http://acme.com/token")',
      ]);
    });

    it("rejects a plaintext app-manifest exchange, which carries app credentials back", () => {
      const issues = validateThirdPartyManifest(
        manifest({
          auth: [
            {
              kind: "app_manifest",
              create_url: "https://acme.com/apps/new",
              delivery: "form_post",
              manifest_param: "manifest",
              manifest: {},
              exchange: { url: "http://acme.com/convert", map: { pem: "ACME_KEY" } },
            },
          ],
        })
      );
      expect(issues).toEqual([
        'auth.app_manifest.exchange.url must be an https:// URL (got "http://acme.com/convert")',
      ]);
    });

    it("rejects a plaintext install url", () => {
      const issues = validateThirdPartyManifest(
        manifest({ auth: [{ kind: "install", url: "http://acme.com/install" }] })
      );
      expect(issues).toEqual([
        'auth.install.url must be an https:// URL (got "http://acme.com/install")',
      ]);
    });

    it("checks the refresh_url as well as the token_url", () => {
      const issues = validateThirdPartyManifest(
        manifest({
          auth: [
            {
              kind: "oauth2",
              authorization_url: "https://acme.com/authorize",
              token_url: "https://acme.com/token",
              refresh_url: "http://acme.com/refresh",
              client_id_env: "ACME_CLIENT_ID",
              client_secret_env: "ACME_CLIENT_SECRET",
              token_env: "ACME_TOKEN",
            },
          ],
        })
      );
      expect(issues).toEqual([
        'auth.oauth2.refresh_url must be an https:// URL (got "http://acme.com/refresh")',
      ]);
    });

    it("rejects a plaintext sse MCP url", () => {
      const issues = validateThirdPartyManifest(
        manifest({
          egress: { type: "mcp", entry: { transport: "sse", url: "http://mcp.acme.com/sse" } },
        })
      );
      expect(issues).toEqual([
        'egress.entry.url must be an https:// URL (got "http://mcp.acme.com/sse")',
      ]);
    });

    it("rejects a scheme-relative URL, which is not literally https", () => {
      const issues = validateThirdPartyManifest(
        manifest({ auth: [{ kind: "install", url: "//acme.com/install" }] })
      );
      expect(issues).toHaveLength(1);
    });

    // A `fields` step is operator-typed values with no outbound request, so there is nothing to
    // check — and no reason to reject an integration for having one.
    it("accepts a fields-only flow", () => {
      expect(
        validateThirdPartyManifest(
          manifest({
            auth: [
              { kind: "fields", fields: [{ name: "ACME_TOKEN", label: "Token", secret: true }] },
            ],
          })
        )
      ).toEqual([]);
    });

    // resolveAuthSteps() synthesizes steps for manifests written before `auth` existed, so a
    // legacy manifest cannot smuggle a plaintext endpoint past the same checks.
    it("checks legacy `oauth` blocks, which resolve to the same steps", () => {
      const issues = validateThirdPartyManifest(
        manifest({
          oauth: {
            flows: {
              authorizationCode: {
                authorizationUrl: "https://acme.com/authorize",
                tokenUrl: "http://acme.com/token",
                scopes: {},
              },
            },
            "x-tulipfarm": {
              client_id_env: "ACME_CLIENT_ID",
              client_secret_env: "ACME_CLIENT_SECRET",
              token_env: "ACME_TOKEN",
            },
          },
        })
      );
      expect(issues).toEqual([
        'auth.oauth2.token_url must be an https:// URL (got "http://acme.com/token")',
      ]);
    });
  });
});

describe("validateThirdPartyManifest — URL authority", () => {
  const withInstallUrl = (url: string) =>
    validateThirdPartyManifest({
      name: "acme",
      egress: { type: "none" },
      auth: [{ kind: "install", url }],
    });

  // The point of checking the URL at all is that a reviewer can see where credentials go. A
  // placeholder in the host defers that to a runtime value the manifest itself can influence.
  it("rejects a placeholder in the host", () => {
    const issues = withInstallUrl("https://{code}.evil.com/install");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("literally");
  });

  it("allows placeholders in the path and query, which cannot change the destination host", () => {
    expect(withInstallUrl("https://acme.com/apps/{ACME_SLUG}/new?state={state}")).toEqual([]);
  });

  it("rejects a URL with no host", () => {
    expect(withInstallUrl("https://")).toEqual([
      'auth.install.url is not a valid URL (got "https://")',
    ]);
  });

  // The real GitHub manifest templates the one-time code into the path — this must keep passing.
  it("accepts the shipped GitHub exchange URL shape", () => {
    expect(
      validateThirdPartyManifest({
        name: "acme",
        egress: { type: "none" },
        auth: [
          {
            kind: "app_manifest",
            create_url: "https://github.com/settings/apps/new?state={state}",
            delivery: "form_post",
            manifest_param: "manifest",
            manifest: {},
            exchange: {
              url: "https://api.github.com/app-manifests/{code}/conversions",
              map: { pem: "GITHUB_APP_PRIVATE_KEY" },
            },
          },
        ],
      })
    ).toEqual([]);
  });
});

describe("icon", () => {
  const base = { name: "acme", egress: { type: "none" } } as const;

  it("accepts a Simple Icons slug", () => {
    expect(validateThirdPartyManifest({ ...base, icon: "linear" })).toEqual([]);
    // A handful of slugs disambiguate with an underscore, e.g. `hive_blockchain`.
    expect(validateThirdPartyManifest({ ...base, icon: "hive_blockchain" })).toEqual([]);
  });

  it("accepts a manifest that declares no icon", () => {
    expect(validateThirdPartyManifest(base)).toEqual([]);
  });

  it("refuses anything that could steer the icon lookup off its slug", () => {
    // The slug reaches a file read on the host, so a separator or a traversal sequence is refused
    // here rather than sanitized at the read — a third party never gets to aim that read.
    for (const icon of ["../../../etc/passwd", "linear/../../x", "linear.svg", "Linear", "a b"]) {
      expect(validateThirdPartyManifest({ ...base, icon })).toEqual([
        expect.stringContaining("icon must be a Simple Icons slug"),
      ]);
    }
  });
});
