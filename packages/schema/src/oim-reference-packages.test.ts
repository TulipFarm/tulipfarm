/**
 * The shipped reference packages are the standard's acceptance evidence.
 *
 * They are validated as *files on disk*, not as fixtures: a manifest that only exists in a test is
 * proof that the schema accepts something, whereas these prove that what TulipFarm ships can
 * actually be installed and compiled by the same path a third-party package takes.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { oimFileDigest, oimGraphqlOperationKind, oimPackageIssues, parseOimManifest } from "./oim";

const ROOT = join(__dirname, "..", "..", "..", "integrations");

async function loadPackage(slug: string) {
  const dir = join(ROOT, slug);
  const manifest = parseOimManifest(await readFile(join(dir, "oim.yml"), "utf8"));
  const companions = new Map<string, string>();
  for (const file of manifest.files ?? []) {
    companions.set(file.path, await readFile(join(dir, file.path), "utf8"));
  }
  return { dir, manifest, companions };
}

/** Every file in the package, as manifest-relative paths, so a companion in a subdirectory counts. */
async function files(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(...(await files(join(dir, entry.name), `${path}/`)));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}

async function oimSlugs(): Promise<string[]> {
  const entries = await readdir(ROOT, { withFileTypes: true });
  const slugs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(join(ROOT, entry.name));
    if (files.includes("oim.yml")) slugs.push(entry.name);
  }
  return slugs.sort();
}

describe("shipped OIM reference packages", () => {
  it("ships at least one", async () => {
    expect((await oimSlugs()).length).toBeGreaterThan(0);
  });

  it("every shipped package parses and has no package issues", async () => {
    for (const slug of await oimSlugs()) {
      const { manifest, companions } = await loadPackage(slug);
      expect([slug, oimPackageIssues(manifest, companions)]).toEqual([slug, []]);
    }
  });

  it("every shipped package declares no hooks and no undeclared companions", async () => {
    for (const slug of await oimSlugs()) {
      const { dir, manifest, companions } = await loadPackage(slug);
      expect(manifest.hooks ?? []).toEqual([]);

      const declared = new Set((manifest.files ?? []).map((file) => file.path));
      const onDisk = (await files(dir)).filter(
        (name) => name !== "oim.yml" && name !== "setup-guide.md"
      );
      expect([slug, onDisk.filter((name) => !declared.has(name))]).toEqual([slug, []]);

      for (const file of manifest.files ?? []) {
        expect(oimFileDigest(companions.get(file.path) ?? "")).toBe(file.sha256);
      }
    }
  });

  it("openweather reaches only OpenWeather, reads only, and never projects the key back", async () => {
    const { manifest } = await loadPackage("openweather");

    for (const operation of manifest.operations) {
      expect(operation.effect).toBe("read");
      expect(operation.identityMode).toBe("shared_only");
      expect(operation.credentialSlot).toBe("api_key");
      expect(operation.source.type).toBe("http");
      if (operation.source.type === "http") {
        expect(new URL(operation.source.baseUrl).host).toBe("api.openweathermap.org");
        // The key travels as a query parameter, so a projection naming it would put a Secret in a
        // Tool result. No projection may reference the injected parameter.
        expect(
          operation.response.mode === "binary" ? [] : (operation.response.projection ?? [])
        ).not.toContain("/appid");
      }
      expect(operation.rateLimit?.requests).toBeGreaterThan(0);
    }

    expect(manifest.auth?.healthCheckOperationId).toBe("current-weather");
    expect(manifest.auth?.credentialSlots.map((slot) => slot.kind)).toEqual(["api_key"]);
  });

  it("confluence reaches only the configured Atlassian site and reads only", async () => {
    const { manifest } = await loadPackage("confluence");

    expect(manifest.auth?.allowedOriginHosts).toEqual(["*.atlassian.net"]);
    for (const operation of manifest.operations) {
      expect(operation.effect).toBe("read");
      expect(operation.source.type).toBe("http");
      if (operation.source.type === "http") {
        // Every operation defers to the same configured origin: one that hard-coded a host would
        // reach a different tenant than the Connection the caller chose.
        expect(operation.source.baseUrl).toBe("https://{site}");
      }
      expect(operation.rateLimit?.requests).toBeGreaterThan(0);
    }
  });

  it("confluence preserves source permissions per page, not per space", async () => {
    const { manifest } = await loadPackage("confluence");

    expect(manifest.knowledge?.acl?.mode).toBe("item");
    expect(manifest.knowledge?.deletion.kind).toBe("absent_from_full_list");
    expect(manifest.knowledge?.identity?.user?.operationId).toBe("get-user");
    expect(manifest.knowledge?.identity?.group?.operationId).toBe("get-group-members");
  });

  it("gitlab declares typed events whose verification and dedup keys are both header-borne", async () => {
    const { manifest } = await loadPackage("gitlab");

    expect(manifest.profiles.events).toBe("1.0");
    expect(manifest.events?.verification.scheme).toBe("shared_secret");
    // The Secret arrives verbatim in a header, so the slot holding it must be declared as a
    // webhook secret rather than reusing the API credential.
    const secretSlot = manifest.events?.verification.secretSlot;
    const slot = manifest.auth?.credentialSlots.find((entry) => entry.id === secretSlot);
    expect(slot?.kind).toBe("webhook_secret");
    expect(manifest.events?.deduplication).toEqual({
      kind: "delivery_id_header",
      header: "X-Gitlab-Event-UUID",
    });
    expect(manifest.events?.acceptance?.requireKnownEventType).toBe(true);

    for (const eventType of manifest.events?.eventTypes ?? []) {
      // Every type is picked out of the body. A selector reading a header would classify traffic
      // the signature check never covered.
      expect(eventType.selector.pointer).toBe("/object_kind");
      expect(eventType.selector.equals).toBeDefined();
      expect(eventType.safeHeaders ?? []).not.toContain("X-Gitlab-Token");
    }
  });

  it("gitlab reaches only the configured GitLab host, with the token in a header", async () => {
    const { manifest } = await loadPackage("gitlab");

    expect(manifest.auth?.allowedOriginHosts).toEqual(["gitlab.com", "*.gitlab.com"]);
    for (const operation of manifest.operations) {
      expect(operation.source.type).toBe("http");
      if (operation.source.type === "http") {
        expect(operation.source.baseUrl).toBe("https://{gitlab_host}");
      }
      expect(operation.credentialSlot).toBe("access_token");
      expect(operation.credentialInjection).toEqual({
        in: "header",
        name: "PRIVATE-TOKEN",
        format: "{token}",
      });
      // A personal token is the point: a Connection may carry the caller's own access rather than
      // one shared account's.
      expect(operation.identityMode).toBe("shared_or_personal");
      expect(operation.rateLimit?.requests).toBeGreaterThan(0);
    }
  });

  it("jira reaches only the configured Atlassian site with an encoded basic credential", async () => {
    const { manifest } = await loadPackage("jira");

    expect(manifest.auth?.allowedOriginHosts).toEqual(["*.atlassian.net"]);
    for (const operation of manifest.operations) {
      expect(operation.source.type).toBe("http");
      if (operation.source.type === "http") {
        expect(operation.source.baseUrl).toBe("https://{jira_site}");
      }
      expect(operation.credentialSlot).toBe("api_credential");
      // Jira Cloud takes base64 of `email:token`. The encoding is declared so the runtime does it,
      // rather than an operator pasting a base64 blob they cannot read back.
      expect(operation.credentialInjection).toEqual({
        in: "header",
        name: "Authorization",
        format: "Basic {token}",
        encoding: "basic",
      });
      expect(operation.identityMode).toBe("shared_or_personal");
      expect(operation.rateLimit?.requests).toBeGreaterThan(0);
    }
  });

  it("jira declares its JQL search as a read even though Jira posts it", async () => {
    const { manifest } = await loadPackage("jira");
    const search = manifest.operations.find((operation) => operation.id === "search-issues");

    expect(search?.effect).toBe("read");
    expect(search?.source.type === "http" && search.source.method).toBe("POST");
  });

  it("linear sends only documents the package ships, with variables closed", async () => {
    const { manifest, companions } = await loadPackage("linear");

    expect(manifest.auth?.allowedOriginHosts).toEqual(["api.linear.app"]);
    const graphqlFiles = new Set(
      (manifest.files ?? []).filter((file) => file.role === "graphql").map((file) => file.path)
    );
    expect(graphqlFiles.size).toBe(manifest.operations.length);

    for (const operation of manifest.operations) {
      expect(operation.source.type).toBe("graphql");
      if (operation.source.type !== "graphql") continue;
      expect(operation.source.url).toBe("https://api.linear.app/graphql");
      expect(graphqlFiles.has(operation.source.documentFile)).toBe(true);
      // An open variables object would let an Agent send a variable the document never declared.
      const request = operation.requestSchema as Record<string, unknown> | undefined;
      if (request !== undefined) expect(request.additionalProperties).toBe(false);
      expect(operation.credentialInjection).toEqual({
        in: "header",
        name: "Authorization",
        format: "{token}",
      });
    }

    for (const [path, content] of companions) {
      // A document that names another operation would let one Tool's approval cover another's call.
      expect([path, /\b(query|mutation)\b/.test(content)]).toEqual([path, true]);
    }
  });

  /**
   * Basic auth carries a base64 pair, not a bearer string. A package that writes the header format
   * but forgets the encoding sends the raw secret and is refused by the provider on every call —
   * a failure no schema check catches, because both fields are individually valid.
   */
  it("never writes a Basic header without asking for the encoding", async () => {
    for (const slug of await oimSlugs()) {
      const { manifest } = await loadPackage(slug);

      const unencoded = manifest.operations
        .filter((operation) => operation.credentialInjection?.format?.startsWith("Basic "))
        .filter((operation) => operation.credentialInjection?.encoding !== "basic")
        .map((operation) => operation.id);

      expect([slug, unencoded]).toEqual([slug, []]);
    }
  });

  it("telegram keeps its bot token out of every response it hands back", async () => {
    const { manifest } = await loadPackage("telegram");

    expect(manifest.profiles.core).toBe("1.1");
    for (const operation of manifest.operations) {
      // Telegram addresses every endpoint as /bot{token}/method, so the credential is part of the
      // URL. That makes a leak a *URL* leak: nothing may echo the path back to an Agent.
      expect(operation.credentialInjection).toMatchObject({ in: "path", format: "bot{token}" });
      expect(operation.source.type).toBe("http");
      if (operation.source.type === "http") {
        expect(operation.source.path.startsWith("/{credential}/")).toBe(true);
        expect(operation.source.baseUrl).toBe("https://api.telegram.org");
      }
      expect(
        operation.response.mode === "binary" ? [] : (operation.response.projection ?? [])
      ).not.toContain("/url");
    }
  });

  it("telegram pins the long-poll timeout rather than letting an Agent raise it", async () => {
    const { manifest } = await loadPackage("telegram");
    const updates = manifest.operations.find((operation) => operation.id === "get-updates");
    const parameters = updates?.source.type === "http" ? (updates.source.parameters ?? []) : [];

    expect(parameters.find((parameter) => parameter.name === "timeout")?.value).toBe("0");
  });

  it("trello declares its API key and token as distinct query credential slots", async () => {
    const { manifest } = await loadPackage("trello");
    const operation = manifest.operations.find((candidate) => candidate.id === "get-member");

    expect(manifest.profiles.core).toBe("1.1");
    expect(manifest.auth?.credentialSlots.map((slot) => slot.id)).toEqual(["api_key", "token"]);
    expect(operation?.credentialInjection).toEqual({
      in: "query",
      name: "key",
      format: "{token}",
    });
    expect(operation?.secondaryCredential).toEqual({
      slot: "token",
      injection: { in: "query", name: "token", format: "{token}" },
    });
  });

  it("twilio addresses only the configured account and never guesses one from an argument", async () => {
    const { manifest } = await loadPackage("twilio");

    expect(manifest.auth?.configurationFields?.map((field) => field.id)).toEqual(["account_sid"]);
    for (const operation of manifest.operations) {
      expect(operation.source.type).toBe("http");
      if (operation.source.type !== "http") continue;
      expect(operation.source.baseUrl).toBe("https://api.twilio.com");
      expect(operation.source.path).toContain("{account_sid}");
      // `account_sid` must never also be a parameter: an Agent able to set it could address an
      // account this Connection was never authorized for.
      const names = (operation.source.parameters ?? []).map((parameter) => parameter.name);
      expect(names).not.toContain("account_sid");
    }
  });

  it("twilio's form bodies are flat, because a nested one has no portable encoding", async () => {
    const { manifest } = await loadPackage("twilio");

    for (const operation of manifest.operations) {
      if (operation.source.type !== "http" || operation.source.contentType !== "form") continue;
      const properties = (operation.requestSchema as { properties?: Record<string, unknown> })
        .properties;
      for (const property of Object.values(properties ?? {})) {
        expect((property as { type?: string }).type).not.toBe("object");
        expect((property as { type?: string }).type).not.toBe("array");
      }
    }
  });

  it("notion pins its API version and never exposes its own cursor to an Agent", async () => {
    const { manifest } = await loadPackage("notion");

    for (const operation of manifest.operations) {
      expect(operation.source.type).toBe("http");
      if (operation.source.type !== "http") continue;
      // Notion refuses a request with no version, and the pinned value is what the declared
      // response schema describes. An Agent that could choose it would get an undescribed body.
      const version = (operation.source.parameters ?? []).find(
        (parameter) => parameter.name === "Notion-Version"
      );
      expect([operation.id, version?.value]).toEqual([operation.id, "2022-06-28"]);

      if (operation.pagination === undefined) continue;
      expect(operation.pagination).toMatchObject({
        type: "body_cursor",
        requestPointer: "/start_cursor",
      });
      const properties = (operation.requestSchema as { properties?: Record<string, unknown> })
        .properties;
      expect(properties?.start_cursor).toBeUndefined();
    }
  });

  it("hubspot's OAuth step ships no client of its own, so quota and suspension stay the operator's", async () => {
    const { manifest } = await loadPackage("hubspot");
    const step = manifest.auth?.steps.find((candidate) => candidate.type === "oauth2");
    if (step?.type !== "oauth2") throw new Error("expected an oauth2 step");

    // Both must resolve to slots a person fills in, never to a literal shipped in the file.
    expect(step.clientId.type).toBe("credential");
    expect(step.clientSecret?.type).toBe("credential");
    const fields = manifest.auth?.steps
      .filter((candidate) => candidate.type === "fields")
      .flatMap((candidate) => (candidate.type === "fields" ? candidate.fields : []));
    for (const slot of [step.clientId.slot, step.clientSecret?.slot]) {
      expect(
        fields?.some((field) => field.target.type === "credential" && field.target.slot === slot)
      ).toBe(true);
    }
  });

  it("hubspot binds both tokens, so a lapsed access token can be renewed rather than re-consented", async () => {
    const { manifest } = await loadPackage("hubspot");
    const step = manifest.auth?.steps.find((candidate) => candidate.type === "oauth2");
    if (step?.type !== "oauth2") throw new Error("expected an oauth2 step");

    const paths = step.bindings.map((binding) => binding.sourcePath);
    expect(paths).toContain("/access_token");
    expect(paths).toContain("/refresh_token");
  });

  it("linear's declared effects match what each document actually does", async () => {
    const { manifest, companions } = await loadPackage("linear");

    for (const operation of manifest.operations) {
      if (operation.source.type !== "graphql") continue;
      const document = companions.get(operation.source.documentFile) ?? "";
      const kind = oimGraphqlOperationKind(document, operation.source.operation);
      expect([operation.id, kind]).toEqual([
        operation.id,
        operation.effect === "read" ? "query" : "mutation",
      ]);
    }
  });
});
