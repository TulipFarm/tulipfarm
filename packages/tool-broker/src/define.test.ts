import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ajv, RoleSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  defineTool,
  RESOURCE_NAME_PATTERN,
  ToolDefinitionError,
  toolContractSpecOf,
} from "./define";

const base = {
  name: "record_create",
  description: "Create a record",
  tier: "system" as const,
  inputSchema: { type: "object" as const },
  authorization: { action: "record.create" },
  handler: async () => ({ ok: true }),
};

describe("defineTool", () => {
  it("keeps a read-only Tool free of idempotency obligations", () => {
    const tool = defineTool({ ...base, mutating: false });
    expect(tool.idempotency).toBe("none");
    expect(tool.riskClass).toBe("low");
  });

  it("defaults a mutating Tool to reconcile rather than leaving duplicates unhandled", () => {
    const tool = defineTool({ ...base, mutating: true });
    expect(tool.idempotency).toBe("reconcile");
    expect(tool.riskClass).toBe("medium");
  });

  it("refuses a mutating Tool that declares duplicates acceptable", () => {
    expect(() => defineTool({ ...base, mutating: true, idempotency: "none" })).toThrow(
      ToolDefinitionError
    );
  });

  it("refuses a credential mode with no provider to spend it on", () => {
    expect(() => defineTool({ ...base, mutating: false, credentialMode: "user" })).toThrow(
      /credentialMode is meaningless/
    );
  });

  it("refuses a name the registry cannot address", () => {
    expect(() => defineTool({ ...base, name: "Record-Create", mutating: false })).toThrow(
      /lower_snake_case/
    );
  });

  it("refuses a resource name outside the two-level grammar", () => {
    expect(() =>
      defineTool({
        ...base,
        mutating: false,
        authorization: { action: "record.read", resources: ["record.a.b.c"] },
      })
    ).toThrow(/not a valid name/);
  });

  it("derives per-call targets from arguments, not from the tool name", () => {
    const tool = defineTool({
      ...base,
      mutating: true,
      authorization: {
        action: "record.create",
        resources: ["record"],
        targets: (args) => [
          { type: "record", id: String((args as { resourceType: string }).resourceType) },
        ],
      },
    });

    expect(tool.targetsFor({ resourceType: "leave_request" })).toEqual([
      { type: "record", id: "leave_request" },
    ]);
    // The distinction the whole gate rests on: two calls to one Tool authorize differently.
    expect(tool.targetsFor({ resourceType: "eng_ticket" })).toEqual([
      { type: "record", id: "eng_ticket" },
    ]);
  });

  it("returns no targets when a Tool names no specific resource", () => {
    expect(defineTool({ ...base, mutating: false }).targetsFor({})).toEqual([]);
  });

  it("reports a throwing derivation as a definition defect, not a dispatch failure", () => {
    const tool = defineTool({
      ...base,
      mutating: false,
      authorization: {
        action: "record.read",
        targets: () => {
          throw new Error("boom");
        },
      },
    });
    expect(() => tool.targetsFor({})).toThrow(ToolDefinitionError);
  });
});

describe("toolContractSpecOf", () => {
  it("projects a local Tool into the same contract shape an imported one uses", () => {
    const spec = toolContractSpecOf(
      defineTool({
        ...base,
        mutating: true,
        provider: "github",
        credentialMode: "user_preferred",
        idempotency: "provider",
        authorization: {
          action: "issue.create",
          resources: ["integration.github"],
          dataClasses: ["internal"],
          allowedDestinations: ["api.github.com"],
        },
      })
    );

    expect(spec.adapter).toEqual({ kind: "integration", ref: "github" });
    expect(spec.requiredActions).toEqual(["issue.create"]);
    expect(spec.requiredResources).toEqual(["integration.github"]);
    expect(spec.allowedDestinations).toEqual(["api.github.com"]);
    expect(spec.idempotency.strategy).toBe("provider");
  });

  it("binds a local Tool to the native adapter", () => {
    const spec = toolContractSpecOf(defineTool({ ...base, mutating: false }));
    expect(spec.adapter).toEqual({ kind: "native", ref: "record_create" });
  });
});

describe("targetsFor robustness", () => {
  it("drops a ref built from an absent argument rather than authorizing against nonsense", () => {
    const tool = defineTool({
      ...base,
      mutating: false,
      authorization: {
        action: "record.read",
        resources: ["record"],
        targets: (args) => [{ type: "record", id: String((args as { type: string }).type) }],
      },
    });
    // `String(undefined)` is "undefined" — a ref naming no resource. Asking the gate about it
    // would put a fabricated target in the audit trail.
    expect(tool.targetsFor({})).toEqual([]);
    expect(tool.targetsFor({ type: "leave_request" })).toEqual([
      { type: "record", id: "leave_request" },
    ]);
  });
});

describe("grant-expressibility", () => {
  // An action a grant cannot name is a Tool no one can ever be given access to. This grammar and
  // the Role artifact's `actionPattern` must therefore stay in lockstep.
  it("rejects an action with no namespace segment", () => {
    expect(() =>
      defineTool({ ...base, mutating: false, authorization: { action: "notion_search" } })
    ).toThrow(ToolDefinitionError);
  });

  it("accepts snake_case vocabulary, which imported Tools carry verbatim", () => {
    const tool = defineTool({
      ...base,
      mutating: false,
      authorization: { action: "soul.resource_type.update", resources: ["soul.resource_type"] },
    });
    expect(tool.authorization.action).toBe("soul.resource_type.update");
  });

  it("drops duplicate resources, which the published contract rejects as non-unique", () => {
    const tool = defineTool({
      ...base,
      mutating: false,
      authorization: { action: "record.read", resources: ["record.a", "record.a"] },
    });
    expect(tool.authorization.resources).toEqual(["record.a"]);
    expect(toolContractSpecOf(tool).requiredResources).toEqual(["record.a"]);
  });
});

describe("authority is never inferred", () => {
  it("refuses to guess whose credential a provider-bearing Tool spends", () => {
    expect(() =>
      defineTool({
        ...base,
        mutating: false,
        provider: "github",
        authorization: base.authorization,
      })
    ).toThrow(/requires an explicit credentialMode/);
  });

  it("refuses to guess how a provider-bound mutation survives a duplicate", () => {
    expect(() =>
      defineTool({
        ...base,
        mutating: true,
        provider: "github",
        credentialMode: "user_preferred",
        authorization: base.authorization,
      })
    ).toThrow(/must declare idempotency explicitly/);
  });

  it("still defaults a local mutation, which no external system observes twice", () => {
    const tool = defineTool({ ...base, mutating: true, authorization: base.authorization });
    expect(tool.idempotency).toBe("reconcile");
    expect(tool.credentialMode).toBe("service");
  });
});

describe("derived targets cannot widen authority", () => {
  const injected = (type: string) =>
    defineTool({
      ...base,
      mutating: false,
      authorization: {
        action: "record.read",
        targets: () => [{ type, id: "rec-1" }],
      },
    }).targetsFor({});

  // The second level of a target type is routinely interpolated from a caller-supplied argument
  // (`record.${args.type}`). Static resources are checked at definition time; derived targets are
  // the only ones an attacker can influence, so they are checked at every call.
  it("rejects a target type carrying a wildcard", () => {
    expect(() => injected("record.*")).toThrow(ToolDefinitionError);
  });

  it("rejects a target type carrying an injected separator", () => {
    expect(() => injected("record.foo.bar")).toThrow(ToolDefinitionError);
  });

  it("rejects a target type carrying an uninterpretable separator", () => {
    expect(() => injected("kv.cache:v1")).toThrow(ToolDefinitionError);
  });

  it("rejects a target id reserved as a grant wildcard", () => {
    const tool = defineTool({
      ...base,
      mutating: false,
      authorization: {
        action: "record.read",
        targets: () => [{ type: "record", id: "*" }],
      },
    });

    expect(() => tool.targetsFor({})).toThrow(/reserved for grant wildcards/);
  });

  it("normalizes uppercase in the caller-owned target segment", () => {
    expect(injected("record.Ticket")).toEqual([{ type: "record.ticket", id: "rec-1" }]);
  });

  it("keeps a well-formed derived target", () => {
    expect(injected("record.employee")).toEqual([{ type: "record.employee", id: "rec-1" }]);
  });
});

describe("Role grant resource expressibility", () => {
  const roleResourcePattern = RoleSchema.properties.spec.properties.grants.items.properties.resource
    .properties.types.items.pattern as string;
  const roleResourceName = new RegExp(roleResourcePattern);
  const toolResourceName = new RegExp(RESOURCE_NAME_PATTERN);

  function tsFiles(dir: string): string[] {
    return readdirSync(dir)
      .flatMap((entry) => {
        const path = join(dir, entry);
        const stats = statSync(path);
        if (stats.isDirectory()) return tsFiles(path);
        return path.endsWith(".ts") ? [path] : [];
      })
      .sort();
  }

  function declaredResourceTypes(): readonly string[] {
    const roots = [
      fileURLToPath(new URL("../../../apps/api/src", import.meta.url)),
      fileURLToPath(new URL("../../integrations/src", import.meta.url)),
    ];
    const values = new Set<string>();

    const files = roots
      .flatMap(tsFiles)
      .filter((file) => file.endsWith("tools.ts") || file.endsWith("contracts.ts"));
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const constants = new Map<string, string>();
      for (const match of source.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*"([^"]+)"/g)) {
        constants.set(match[1], match[2]);
        if (match[1].endsWith("_TARGET")) values.add(match[2]);
      }
      for (const match of source.matchAll(/resources:\s*\[([^\]]+)\]/g)) {
        const body = match[1];
        for (const literal of body.matchAll(/"([^"]+)"/g)) values.add(literal[1]);
        for (const identifier of body.matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)) {
          const value = constants.get(identifier[1]);
          if (value !== undefined) values.add(value);
        }
      }
    }

    return [...values].sort();
  }

  function roleAcceptsResourceTypes(types: readonly string[]): boolean {
    return ajv.validate(RoleSchema, {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Role",
      metadata: {
        id: "018f5b88-2a88-7b0f-9f48-88c9e6f6f621",
        slug: "resource-vocabulary",
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "draft",
      },
      spec: {
        principalTypes: ["user"],
        grants: [
          {
            effect: "allow",
            actions: ["record.read"],
            resource: { types },
            delegable: false,
          },
        ],
      },
    });
  }

  it("keeps Role resource types in lockstep with Tool resource names", () => {
    const corpus = [
      ...declaredResourceTypes(),
      "platform.knowledge",
      "platform.kv",
      "platform.memory",
      "soul.skill",
      "soul.agent",
      "soul.resource_type",
      "soul.surface_component",
      "integration.github",
      "integration.slack",
      "record.ticket",
      "github.repository",
      "github.installation",
      "slack.channel",
      "google_docs.document",
    ];

    for (const resource of new Set(corpus)) {
      expect(roleResourceName.test(resource), resource).toBe(toolResourceName.test(resource));
    }
  });

  it("accepts every declared Tool resource type in a Role grant", () => {
    const types = declaredResourceTypes();

    expect(types.length).toBeGreaterThan(0);
    expect(roleAcceptsResourceTypes(types), JSON.stringify(ajv.errors, null, 2)).toBe(true);
  });
});

describe("contract fidelity", () => {
  it("carries timeout and compensation, which the reconciler reads", () => {
    const spec = toolContractSpecOf(
      defineTool({
        ...base,
        mutating: true,
        provider: "github",
        credentialMode: "user_preferred",
        idempotency: "reconcile",
        timeout: { wallClockMs: 15_000 },
        compensation: { reconciliation: "github.issue.read" },
        authorization: base.authorization,
      })
    );
    expect(spec.timeout).toEqual({ wallClockMs: 15_000 });
    expect(spec.compensation).toEqual({ reconciliation: "github.issue.read" });
  });
});

describe("derived targets cannot silently drop a declared resource", () => {
  const withTargets = (resources: string[], targets: readonly { type: string; id: string }[]) =>
    defineTool({
      ...base,
      mutating: false,
      authorization: { action: "record.read", resources, targets: () => targets },
    }).targetsFor({});

  // `authorizeToolIntent` checks derived targets *instead of* the static resources, not in addition
  // to them. Deriving nothing is fail-closed, but the instant one ref survives every declared
  // resource stops being checked — so an over-narrow derivation is a privilege escalation.
  it("refuses a derivation that escapes the declared resource", () => {
    expect(() => withTargets(["platform.kv"], [{ type: "kv", id: "scratch" }])).toThrow(
      ToolDefinitionError
    );
    expect(() => withTargets(["platform.kv"], [{ type: "kv", id: "scratch" }])).toThrow(
      /dropped declared resource\(s\) \[platform\.kv\]/
    );
  });

  it("allows a narrower target alongside the declared resource", () => {
    expect(
      withTargets(
        ["record"],
        [
          { type: "record", id: "ticket" },
          { type: "record.ticket", id: "t-1" },
        ]
      )
    ).toHaveLength(2);
  });

  // Deriving nothing must stay permitted: that is the fail-closed path where the coarse static
  // resource becomes the check.
  it("leaves an empty derivation alone", () => {
    expect(withTargets(["platform.kv"], [])).toEqual([]);
  });

  it("refuses a partial drop when several resources are declared", () => {
    expect(() =>
      withTargets(["platform.kv", "platform.memory"], [{ type: "platform.kv", id: "n" }])
    ).toThrow(/dropped declared resource\(s\) \[platform\.memory\]/);
  });
});
