import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";
import {
  githubAccessFixture,
  githubAccountFixture,
  githubDefinitionFixture,
  githubEligibilityFixture,
} from "../app/components/integrations/mcp-setup.fixtures.ts";

const scratch = resolve(`node_modules/.cache/integration-setup-browser-${process.pid}`);
await mkdir(scratch, { recursive: true });
const previousTmpdir = process.env.TMPDIR;
process.env.TMPDIR = scratch;
const server = await createServer({
  configFile: false,
  envDir: false,
  root: new URL("../", import.meta.url).pathname,
  cacheDir: "node_modules/.vite-integration-setup",
  define: {
    "import.meta.env.VITE_API_URL": JSON.stringify(""),
    "import.meta.env.VITE_API_TOKEN": "undefined",
  },
  resolve: { alias: { "~": new URL("../app", import.meta.url).pathname } },
  server: { host: "127.0.0.1", port: 0, watch: null },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "integration-setup-fixture",
      configureServer(vite) {
        vite.middlewares.use("/__integration_setup__", async (request, response, next) => {
          try {
            const html = await vite.transformIndexHtml(
              request.url ?? "/",
              `<!doctype html>
              <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
              <body><div id="root"></div><script type="module" src="/scripts/integration-setup-fixture.tsx"></script></body></html>`
            );
            response.setHeader("Content-Type", "text/html");
            response.end(html);
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});

let browser;
try {
  await server.listen();
  browser = await chromium.launchPersistentContext(resolve(scratch, "profile"));
  const base = server.resolvedUrls.local[0];
  const origin = new URL(base).origin;
  for (const [theme, viewport] of [
    ["light", { width: 1100, height: 900 }],
    ["dark", { width: 390, height: 844 }],
  ]) {
    for (const scenario of [
      "token",
      "finish",
      "retry",
      "custom-empty",
      "unpublished",
      "legacy-catalog",
      "legacy-journal",
      "legacy-standard",
      "legacy-ready",
      "discovered-empty",
      "eligibility-error",
      "stale-revision",
    ]) {
      const page = await browser.newPage();
      await page.setViewportSize(viewport);
      const writes = [];
      const unexpected = [];
      const errors = [];
      const legacyEmpty = [
        "unpublished",
        "legacy-catalog",
        "legacy-journal",
        "legacy-standard",
        "legacy-ready",
      ].includes(scenario);
      const preserve = scenario === "custom-empty" || legacyEmpty;
      const chooseStandard =
        scenario === "legacy-standard" ||
        scenario === "legacy-journal" ||
        scenario === "legacy-ready";
      let standardAdopted = false;
      const authless = scenario === "custom-empty";
      let published = scenario === "custom-empty" || scenario === "legacy-ready";
      const emptyDiscovery = scenario === "discovered-empty";
      let revision = githubEligibilityFixture.definitionRevision;
      let eligibilityReads = 0;
      const configuration = {
        authentication: authless ? "none" : "token",
        requiredSlots: authless ? [] : ["accessToken"],
        sharedAllowed: false,
        definitionDigest: githubAccountFixture.definitionDigest,
      };
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) {
          unexpected.push(request.url());
          return route.abort();
        }
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const reply = (body, status = 200) => route.fulfill({ json: body, status });
        if (
          request.method() === "GET" &&
          url.pathname === "/api/v1/integrations/github-mcp/setup"
        ) {
          eligibilityReads += 1;
          if (scenario === "eligibility-error" && eligibilityReads === 1)
            return reply({ error: "setup_unavailable" }, 503);
          return reply({
            definitionRevision: revision,
            policy: preserve || published ? "preserve" : "initialize",
            publishedReady: published,
            canConfigure: true,
            canUseStandardAccess: legacyEmpty && !standardAdopted,
          });
        }
        if (request.method() === "GET" && url.pathname === "/api/v1/integrations/github-mcp")
          return reply({
            server: {
              ...githubDefinitionFixture,
              server: {
                ...githubDefinitionFixture.server,
                ...(scenario === "custom-empty" || scenario === "unpublished"
                  ? {
                      transport: {
                        type: "streamable-http",
                        url: "https://custom.fixture.invalid/mcp",
                      },
                    }
                  : {}),
                authentication: { type: configuration.authentication, sharedAllowed: false },
              },
              enabled: published || legacyEmpty,
              reviewPolicy:
                legacyEmpty && !standardAdopted
                  ? undefined
                  : published
                    ? preserve && !standardAdopted
                      ? "custom"
                      : "initial"
                    : "uninitialized",
              reviewed:
                published && !emptyDiscovery && (!preserve || standardAdopted)
                  ? githubAccessFixture
                  : { tools: [], resources: [], prompts: [] },
            },
          });
        if (
          request.method() === "GET" &&
          url.pathname === "/api/v1/integrations/github-mcp/accounts"
        )
          return reply(authless ? [] : [githubAccountFixture]);
        if (
          request.method() === "GET" &&
          url.pathname === "/api/v1/integrations/github-mcp/accounts/configuration"
        )
          return reply(configuration);
        if (request.method() === "GET" && url.pathname === "/api/v1/integration-setups")
          return reply({
            operations:
              scenario === "legacy-journal" && !published
                ? [
                    {
                      id: "11111111-1111-4111-8111-111111111111",
                      integrationKey: "github-mcp",
                      accountId: githubAccountFixture.id,
                      status: "retry",
                      error: "capability_changed",
                    },
                  ]
                : [],
          });
        if (
          request.method() === "GET" &&
          url.pathname === "/api/v1/integrations/catalog/github/setup"
        )
          return reply({
            server: {
              id: "github-mcp",
              label: "GitHub",
              transport: { type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" },
              authentication: { type: "token", sharedAllowed: false },
            },
            configuration: {
              authentication: "token",
              requiredSlots: ["accessToken"],
              sharedAllowed: false,
            },
            requiresOAuthApp: true,
          });
        if (
          request.method() === "POST" &&
          /^\/api\/v1\/integration-setups\/[^/]+(?:\/resume)?$/.test(url.pathname)
        ) {
          const body = request.postDataJSON();
          writes.push({ path: url.pathname, body });
          const explicitStandard = body.legacyEmptyPolicyConsent === "use_standard_access";
          if (
            explicitStandard &&
            (!legacyEmpty ||
              standardAdopted ||
              !body.initializePolicy ||
              body.definitionRevision !== revision)
          )
            return reply({ error: "capability_changed" }, 409);
          if (scenario === "legacy-journal" && url.pathname.endsWith("/resume"))
            return reply({
              id: "11111111-1111-4111-8111-111111111111",
              integrationKey: "github-mcp",
              accountId: githubAccountFixture.id,
              status: "retry",
              error: "capability_changed",
            });
          if (scenario === "stale-revision" && writes.length === 1) {
            revision = "d".repeat(64);
            return reply({ error: "definition_changed" }, 409);
          }
          if (
            scenario !== "token" &&
            !url.pathname.endsWith("/resume") &&
            (body.definitionRevision !== revision ||
              body.initializePolicy !== (!preserve || explicitStandard))
          )
            return reply({ error: "definition_changed" }, 409);
          published = !(scenario === "retry" && writes.length === 1);
          standardAdopted ||= explicitStandard;
          if (published) revision = "e".repeat(64);
          return reply({
            id: url.pathname.split("/")[4],
            integrationKey: "github-mcp",
            accountId: "fixture-personal-account",
            status: scenario === "retry" && writes.length === 1 ? "retry" : "done",
            access: {
              enabled: published,
              state: emptyDiscovery
                ? "discovered_empty"
                : preserve && !standardAdopted
                  ? "preserved_empty"
                  : "allowed",
              tools:
                emptyDiscovery || (preserve && !standardAdopted)
                  ? 0
                  : githubAccessFixture.tools.length,
              resources:
                emptyDiscovery || (preserve && !standardAdopted)
                  ? 0
                  : githubAccessFixture.resources.length,
              prompts:
                emptyDiscovery || (preserve && !standardAdopted)
                  ? 0
                  : githubAccessFixture.prompts.length,
            },
            ...(scenario === "retry" && writes.length === 1 ? { error: "setup_failed" } : {}),
          });
        }
        unexpected.push(`${request.method()} ${url.pathname}`);
        return route.abort();
      });
      await page.addInitScript((theme) => {
        document.addEventListener(
          "DOMContentLoaded",
          () => {
            document.documentElement.dataset.theme = theme;
          },
          { once: true }
        );
      }, theme);
      await page.goto(`${base}__integration_setup__?scenario=${scenario}`);
      if (scenario === "legacy-journal") {
        await page.getByRole("button", { name: "Use current settings", exact: true }).waitFor();
        assert.equal(writes.length, 0);
        await page.getByRole("button", { name: "Use current settings", exact: true }).click();
      }
      if (scenario === "eligibility-error") {
        await page.getByRole("alert").waitFor();
        assert.equal(
          await page.getByRole("button", { name: "Finish connecting", exact: true }).count(),
          0
        );
        assert.equal(await page.getByText("Ready to use", { exact: true }).count(), 0);
        assert.equal(writes.length, 0);
        await page.getByRole("button", { name: "Reload setup permissions", exact: true }).click();
      }
      if (scenario === "custom-empty") {
        await page.getByText("No access allowed", { exact: true }).waitFor();
        assert.equal(await page.getByText("Ready to use", { exact: true }).count(), 0);
        assert.equal(await page.getByRole("link", { name: "Open Chat" }).count(), 0);
        await page.getByRole("button", { name: "Edit allowed access", exact: true }).waitFor();
        await page.getByText(/Existing settings allow no Tools or content/).waitFor();
        assert.equal(
          await page.getByRole("button", { name: "Finish connecting", exact: true }).count(),
          0
        );
        assert.equal(await page.getByText(/Every initial Tool call/).count(), 0);
        assert.equal(writes.length, 0);
        assert.deepEqual(unexpected, []);
        assert.deepEqual(errors, []);
        console.log(
          `PASS: ${scenario}, ${theme}, ${viewport.width}px — empty authless policy preserved`
        );
        await page.close();
        continue;
      }
      if (scenario === "token") {
        const token = page.getByLabel("Access token", { exact: true });
        await token.waitFor();
        assert.equal(await token.getAttribute("type"), "password");
        assert.equal(writes.length, 0);
        assert.equal(await page.getByText("Ready to use", { exact: true }).count(), 0);
        await token.fill("fabricated-browser-fixture-token");
        await page.getByRole("button", { name: "Connect", exact: true }).click();
      } else {
        const action = chooseStandard
          ? "Use standard access and connect"
          : legacyEmpty
            ? "Keep existing access and connect"
            : "Finish connecting";
        await page.getByRole("button", { name: action, exact: true }).waitFor();
        assert.equal(writes.length, 0);
        assert.equal(await page.getByText("Ready to use", { exact: true }).count(), 0);
        if (legacyEmpty) assert.equal(await page.getByText(/Every initial Tool call/).count(), 0);
        if (chooseStandard) await page.getByText(/Replace the old empty access policy/).waitFor();
        assert.equal(await page.getByLabel("Access token", { exact: true }).count(), 0);
        await page.getByRole("button", { name: action, exact: true }).click();
        if (scenario === "retry") {
          await page.getByRole("alert").waitFor();
          assert.equal(await page.getByLabel("Access token", { exact: true }).count(), 0);
          await page.getByRole("button", { name: "Finish connecting", exact: true }).click();
          assert.equal(writes[1].path, `${writes[0].path}/resume`);
          assert.deepEqual(writes[1].body, {});
        } else if (scenario === "stale-revision") {
          await page
            .getByRole("alert")
            .filter({ hasText: "changed before setup started" })
            .waitFor();
          assert.equal(await page.getByRole("button", { name: "Done", exact: true }).count(), 0);
          assert.equal(
            writes[0].body.definitionRevision,
            githubEligibilityFixture.definitionRevision
          );
          await page.getByRole("button", { name: "Reload setup permissions", exact: true }).click();
          await page.getByRole("button", { name: "Finish connecting", exact: true }).click();
          assert.equal(writes[1].body.definitionRevision, "d".repeat(64));
          assert.equal(writes[1].body.accountId, writes[0].body.accountId);
          assert.equal(writes[1].body.values, undefined);
        }
      }
      await page
        .getByRole("status")
        .filter({
          hasText:
            emptyDiscovery || (preserve && !standardAdopted)
              ? /^Connected — access needs attention$/
              : /^Connected$/,
        })
        .waitFor();
      if (emptyDiscovery || (preserve && !standardAdopted)) {
        assert.equal(await page.getByRole("link", { name: "Open Chat" }).count(), 0);
        if (emptyDiscovery)
          await page.getByText(/The provider returned no Tools or content/).waitFor();
      }
      assert.equal(writes.length, scenario === "retry" || scenario === "stale-revision" ? 2 : 1);
      if (scenario === "legacy-journal") {
        assert.equal(writes[0].path.endsWith("/resume"), false);
        assert.equal(writes[0].path.includes("11111111-1111-4111-8111-111111111111"), false);
        assert.equal(writes[0].body.initializePolicy, true);
      }
      if (chooseStandard) {
        assert.equal(writes[0].body.legacyEmptyPolicyConsent, "use_standard_access");
        assert.equal(writes[0].body.accountId, githubAccountFixture.id);
        assert.equal(
          writes[0].body.definitionRevision,
          githubEligibilityFixture.definitionRevision
        );
      } else if (legacyEmpty) {
        assert.equal(writes[0].body.initializePolicy, false);
        assert.equal(writes[0].body.legacyEmptyPolicyConsent, undefined);
      }
      assert.equal(await page.getByText("add_issue_comment", { exact: true }).count(), 0);
      assert.equal(await page.getByRole("checkbox", { name: /Approve tools/ }).count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false
      );
      if (scenario === "finish" || scenario === "legacy-standard") {
        await page.getByText("Advanced settings", { exact: true }).click();
        await page.getByText("add_issue_comment", { exact: true }).waitFor();
        await page.getByText("update_pull_request_branch", { exact: true }).waitFor();
        assert.equal(writes.length, 1);
      }
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Fixture complete" }).waitFor();
      assert.deepEqual(unexpected, [], "No real API or provider requests are permitted");
      assert.deepEqual(errors, []);
      console.log(`PASS: ${scenario}, ${theme}, ${viewport.width}px — isolated fixtures only`);
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await server.close();
  if (previousTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpdir;
  await rm(scratch, { recursive: true, force: true });
}
