import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { grantMatches } from "@tulipfarm/authz";
import { PRINCIPAL_KINDS, type RoleDefinition } from "@tulipfarm/schema";
import { InMemoryRoleRepo } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import type { CommitActor, CommitSigner } from "./commit-signing";
import { SoulGitStore } from "./git-store";
import { SoulLoader } from "./published-loader";
import { compileRoleDefinition, compileSoulRoles, SoulRoleCompileError } from "./role-compiler";
import type { Logger } from "./types";
import { SoulWriter } from "./writer";

const TMP = join(import.meta.dirname, "__role_compiler_tmp__");
const BUSINESS = "business-1";
const NOW = new Date("2026-08-12T12:00:00Z");

const ACTOR: CommitActor = {
  principalId: "principal-1",
  name: "Ada",
  email: "ada@example.com",
};

const signer: CommitSigner = {
  keyId: "test-key",
  sign: (payload) => createHmac("sha256", "secret").update(payload).digest("base64"),
};

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function roleDefinition(overrides: Partial<RoleDefinition["spec"]> = {}): RoleDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Role",
    metadata: {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "support-operator",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: {
      principalTypes: ["user"],
      grants: [],
      ...overrides,
    },
  };
}

function request(domain?: string) {
  return {
    action: "ticket.read",
    resourceType: "record.ticket",
    ...(domain === undefined ? {} : { domain }),
  };
}

describe("compileRoleDefinition", () => {
  it("fans plural Role grants out to singular grant rows as a cartesian product", () => {
    const role = compileRoleDefinition(
      roleDefinition({
        grants: [
          {
            effect: "allow",
            actions: ["ticket.read", "ticket.write"],
            resource: { types: ["record.ticket", "tool.github"], recordIds: ["T-1", "T-2"] },
            fields: ["title", "status"],
            domains: ["support", "*"],
            dataClasses: ["internal", "public"],
            destinations: ["slack", "github"],
            conditions: [{ attribute: "context.channel", operator: "equals", value: "support" }],
            expiresAt: "2026-08-13T12:00:00Z",
            delegable: false,
          },
        ],
      }),
      BUSINESS
    );

    expect(role.grants).toHaveLength(64);
    expect(role.grants).toContainEqual({
      action: "ticket.read",
      resourceType: "record.ticket",
      recordSelector: "T-1",
      fieldSelector: ["title", "status"],
      domain: "support",
      dataClass: "internal",
      destination: "slack",
      conditions: { "context.channel": "support" },
      effect: "allow",
      expiresAt: new Date("2026-08-13T12:00:00Z"),
    });
  });

  it("preserves domain values with authz matching semantics intact", () => {
    const role = compileRoleDefinition(
      roleDefinition({
        grants: [
          {
            effect: "allow",
            actions: ["ticket.read"],
            resource: { types: ["record.ticket"] },
            delegable: false,
          },
          {
            effect: "allow",
            actions: ["ticket.read"],
            resource: { types: ["record.ticket"] },
            domains: ["*"],
            delegable: false,
          },
          {
            effect: "allow",
            actions: ["ticket.read"],
            resource: { types: ["record.ticket"] },
            domains: ["support"],
            delegable: false,
          },
        ],
      }),
      BUSINESS
    );

    const domainless = role.grants[0];
    const namedWildcard = role.grants[1];
    const exact = role.grants[2];
    if (domainless === undefined || namedWildcard === undefined || exact === undefined) {
      throw new Error("expected compiled domain grants");
    }

    expect(grantMatches(domainless, request(), NOW)).toBe(true);
    expect(grantMatches(domainless, request("support"), NOW)).toBe(false);
    expect(grantMatches(namedWildcard, request(), NOW)).toBe(false);
    expect(grantMatches(namedWildcard, request("engineering"), NOW)).toBe(true);
    expect(grantMatches(exact, request("support"), NOW)).toBe(true);
    expect(grantMatches(exact, request("engineering"), NOW)).toBe(false);
    expect(grantMatches(namedWildcard, request("*"), NOW)).toBe(false);
  });

  it("fails closed for grant fields the singular row shape cannot express", () => {
    expect(() =>
      compileRoleDefinition(
        roleDefinition({
          grants: [
            {
              effect: "allow",
              actions: ["ticket.read"],
              resource: { types: ["ticket"] },
              audiences: ["operator"],
              delegable: false,
            },
          ],
        }),
        BUSINESS
      )
    ).toThrow(SoulRoleCompileError);
  });
});

describe("Soul Role write, load, compile", () => {
  beforeEach(async () => {
    rmSync(TMP, { recursive: true, force: true });
    await mkdir(TMP, { recursive: true });
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: TMP });
    execFileSync("git", ["config", "user.email", "bot@example.com"], { cwd: TMP });
    execFileSync("git", ["config", "user.name", "bot"], { cwd: TMP });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("round-trips write → load → compile → storage grant rows for all principal kinds", async () => {
    const store = new SoulGitStore(TMP, signer, logger());
    const writer = new SoulWriter(store, logger());
    const definition = roleDefinition({
      principalTypes: [...PRINCIPAL_KINDS],
      inherits: ["22222222-2222-4222-8222-222222222222"],
      grants: [
        {
          effect: "allow",
          actions: ["ticket.read"],
          resource: { types: ["record.ticket"] },
          domains: ["support"],
          delegable: false,
        },
      ],
    });

    await writer.apply({
      subject: "soul: add role support-operator",
      source: "api",
      actor: ACTOR,
      businessId: BUSINESS,
      changes: [
        {
          op: "put",
          target: { kind: "Role", slug: "support-operator" },
          content: stringifyYaml(definition),
        },
      ],
    });

    const loader = new SoulLoader(TMP, logger());
    await loader.load();
    const compiled = compileSoulRoles(loader.roles.values(), BUSINESS);
    const compiledRole = compiled[0];
    if (compiledRole === undefined) throw new Error("expected compiled role");
    const repo = new InMemoryRoleRepo();
    await repo.putRole(compiledRole);

    expect(compiled).toHaveLength(1);
    expect(compiledRole.assignableTo).toEqual([...PRINCIPAL_KINDS]);
    expect(await repo.getRole(BUSINESS, definition.metadata.id)).toEqual({
      id: definition.metadata.id,
      businessId: BUSINESS,
      assignableTo: [...PRINCIPAL_KINDS],
      parentRoleIds: ["22222222-2222-4222-8222-222222222222"],
      grants: [
        {
          action: "ticket.read",
          resourceType: "record.ticket",
          domain: "support",
          effect: "allow",
        },
      ],
    });
  });
});
