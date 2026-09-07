/**
 * The shipped reference packages must compile into Tools by the same path a third-party package
 * takes. Validating the manifest proves it is well-formed; only compiling proves it is callable.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseOimManifest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { compileOimGraphqlOperations } from "./oim-graphql-compile";
import { compileOimHttpOperations, OimHttpCompileError } from "./oim-http-compile";

const ROOT = join(__dirname, "..", "..", "..", "..", "integrations");

async function shipped(slug: string) {
  return parseOimManifest(await readFile(join(ROOT, slug, "oim.yml"), "utf8"));
}

/** The declared companion documents, read the way the soul loader reads them at install. */
async function documents(slug: string) {
  const manifest = await shipped(slug);
  const contents = new Map<string, string>();
  for (const file of manifest.files ?? []) {
    if (file.role !== "graphql") continue;
    contents.set(file.path, await readFile(join(ROOT, slug, file.path), "utf8"));
  }
  return { manifest, contents };
}

describe("shipped reference packages compile", () => {
  it("openweather compiles every operation against its fixed host", async () => {
    const tools = compileOimHttpOperations(await shipped("openweather"));

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.contract.spec.allowedDestinations).toEqual(["api.openweathermap.org"]);
      expect(tool.mutating).toBe(false);
    }
  });

  it("confluence compiles against the site the installation configured", async () => {
    const tools = compileOimHttpOperations(await shipped("confluence"), {
      site: "acme.atlassian.net",
    });

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.contract.spec.allowedDestinations).toEqual(["acme.atlassian.net"]);
      expect(tool.binding.baseUrl).toBe("https://acme.atlassian.net");
      expect(tool.mutating).toBe(false);
    }
  });

  it("confluence refuses a site outside atlassian.net", async () => {
    const manifest = await shipped("confluence");

    expect(() =>
      compileOimHttpOperations(manifest, { site: "confluence.attacker.example" })
    ).toThrow(OimHttpCompileError);
  });

  it("confluence refuses to compile with no site configured", async () => {
    const manifest = await shipped("confluence");

    expect(() => compileOimHttpOperations(manifest)).toThrow(
      expect.objectContaining({ code: "origin_unconfigured" })
    );
  });

  it("gitlab compiles reads and writes against the configured host", async () => {
    const tools = compileOimHttpOperations(await shipped("gitlab"), { gitlab_host: "gitlab.com" });

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.contract.spec.allowedDestinations).toEqual(["gitlab.com"]);
    }
    // Unlike the other two packages, this one writes: the mutating operations must compile as
    // mutating, or an approval gate keyed on that flag would never fire.
    expect(tools.filter((tool) => tool.mutating).map((tool) => tool.name)).toEqual([
      "gitlab_create_issue",
      "gitlab_comment_issue",
    ]);
  });

  it("gitlab refuses a host outside gitlab.com", async () => {
    const manifest = await shipped("gitlab");

    expect(() =>
      compileOimHttpOperations(manifest, { gitlab_host: "gitlab.attacker.example" })
    ).toThrow(expect.objectContaining({ code: "origin_not_allowed" }));
  });

  it("jira compiles against the configured site and encodes its basic credential", async () => {
    const tools = compileOimHttpOperations(await shipped("jira"), {
      jira_site: "acme.atlassian.net",
    });

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.contract.spec.allowedDestinations).toEqual(["acme.atlassian.net"]);
      expect(tool.binding.auth).toEqual({
        in: "header",
        credentialSlot: "api_credential",
        header: "Authorization",
        format: "Basic {token}",
        encoding: "basic",
      });
    }
    expect(
      tools
        .filter((tool) => tool.mutating)
        .map((tool) => tool.name)
        .sort()
    ).toEqual(["jira_create_issue", "jira_transition_issue", "jira_update_issue"]);
  });

  it("jira refuses a site outside Atlassian Cloud", async () => {
    await expect(async () =>
      compileOimHttpOperations(await shipped("jira"), { jira_site: "jira.attacker.example" })
    ).rejects.toThrow(new OimHttpCompileError("origin_not_allowed", "current-user"));
  });

  it("linear compiles every operation from a shipped document", async () => {
    const { manifest, contents } = await documents("linear");
    const tools = compileOimGraphqlOperations(manifest, contents);

    expect(tools).toHaveLength(manifest.operations.length);
    for (const tool of tools) {
      expect(tool.contract.spec.allowedDestinations).toEqual(["api.linear.app"]);
      expect(tool.contract.spec.adapter.kind).toBe("graphql");
      // The document travels in the binding, so nothing an Agent sends can become query text.
      expect(tool.binding.document).not.toBe("");
    }
    expect(
      tools
        .filter((tool) => tool.mutating)
        .map((tool) => tool.name)
        .sort()
    ).toEqual(["linear_create_comment", "linear_create_issue", "linear_update_issue"]);
  });

  it("linear cannot compile without the documents the package ships", async () => {
    const { manifest } = await documents("linear");

    expect(() => compileOimGraphqlOperations(manifest, new Map())).toThrow(
      /oim_graphql_compile:document_missing/
    );
  });

  it("trello compiles its distinct API key and token query bindings", async () => {
    const [tool] = compileOimHttpOperations(await shipped("trello"));

    expect(tool?.binding.auth).toEqual({
      in: "query",
      credentialSlot: "api_key",
      name: "key",
      format: "{token}",
    });
    expect(tool?.binding.secondaryAuth).toEqual({
      in: "query",
      credentialSlot: "token",
      name: "token",
      format: "{token}",
    });
  });
});
