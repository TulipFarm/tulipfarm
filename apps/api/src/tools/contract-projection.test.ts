import {
  ajv,
  MCP_SETUP_TOOL_DECLARATIONS,
  mcpToolContract,
  ToolContractDefinitionSchema,
} from "@tulipfarm/schema";
import { toolContractSpecOf } from "@tulipfarm/tool-broker";
import type { ParkableToolDef, ToolDef } from "@tulipfarm/tool-host";
import { CHAT_DLP_RULES } from "@tulipfarm/tool-host";
import { describe, expect, it } from "vitest";
import { DEPLOYMENT_ROLES } from "../identity/roles";
import { buildToolRegistry } from "./setup";

const validateDefinition = ajv.compile(ToolContractDefinitionSchema);

interface LabeledDefinition {
  readonly family: string;
  readonly definition: NonNullable<ToolDef["definition"]>;
}

function throwOnExecute(): never {
  throw new Error("contract projection must not execute Tools");
}

function definitionsFrom(
  family: string,
  tools: readonly ParkableToolDef[]
): readonly LabeledDefinition[] {
  return tools.flatMap((tool) =>
    tool.definition === undefined ? [] : [{ family, definition: tool.definition }]
  );
}

function localDefinitions(): readonly LabeledDefinition[] {
  const stub = new Proxy({}, { get: () => () => throwOnExecute() }) as never;

  return definitionsFrom(
    "local",
    buildToolRegistry({
      memoryDocuments: stub,
      kv: stub,
      files: stub,
      knowledge: stub,
      resources: stub,
      resourceTypes: stub,
      agentTools: stub,
      integrationAuthoring: stub,
      skillTools: stub,
      surfaceComponents: stub,
      platform: stub,
    }).getAll()
  );
}

const PROBE_ARGUMENTS: readonly unknown[] = [
  {},
  { type: "ticket", id: "t-1" },
  { namespace: "scratch", key: "k" },
  { spaceId: "s-1", path: "handbook", pageId: "p-1" },
  { key: "reply_tone", subject: "weekly_report" },
  { repository: "tulip/farm", owner: "tulip", query: "is:open" },
  { channel: "C0123456789", text: "hi" },
  { agent: "planner", agentName: "planner", route: "/x", name: "act", artifactId: "a-1" },
  { page_id: "p1", document_id: "d1", documentId: "d1" },
  { citations: [{ pageId: "p-1" }] },
];

function allDefinitions(): readonly LabeledDefinition[] {
  return localDefinitions();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

describe("published contract projection", () => {
  it("registers the exact shared MCP setup declarations used by eval", () => {
    const registered = localDefinitions();
    for (const declaration of MCP_SETUP_TOOL_DECLARATIONS) {
      const tool = registered.find(({ definition }) => definition.name === declaration.name);
      expect(tool?.definition).toMatchObject({
        name: declaration.name,
        description: declaration.description,
        mutating: declaration.mutating,
      });
      expect(tool?.definition.inputSchema).toEqual(declaration.inputSchema);
    }
  });

  it("includes platform Tools and current MCP setup declarations", () => {
    const names = allDefinitions().map(({ definition }) => definition.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "soul_repo_push",
        "record_create",
        "file_read",
        "integration_configure",
        "integration_discover",
        "integration_review",
        "integration_resource_read",
        "integration_prompt_render",
      ])
    );
  });

  it.each([false, true])("accepts current MCP contracts with mutating=%s", (mutating) => {
    const contract = mcpToolContract("fitness-server", "a".repeat(64), {
      name: mutating ? "update" : "read",
      inputSchema: { type: "object", additionalProperties: false },
      mutating,
      requiresApproval: mutating,
    });

    expect(validateDefinition(contract)).toBe(true);
    expect(contract.spec.adapter).toEqual({ kind: "mcp", ref: "fitness-server" });
    expect(contract.spec.targets).toEqual([{ type: "integration", id: "fitness-server" }]);
    expect(contract.spec.action).toBe(mutating ? "integration.execute" : "integration.read");
    expect(contract.spec.retry).toEqual({ maxAttempts: 1, safeToRetry: false });
  });

  it("projects every registered Tool into a spec the ToolContract schema accepts", () => {
    const rejected: string[] = [];

    for (const { family, definition } of allDefinitions()) {
      const candidate = {
        apiVersion: "tulipfarm.ai/v1",
        kind: "ToolContract",
        metadata: {
          id: "01J0000000000000000000000A",
          slug: definition.name.replace(/_/g, "-"),
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "published",
          publishedDigest: "a".repeat(64),
        },
        spec: toolContractSpecOf(definition),
      };

      if (!validateDefinition(candidate)) {
        const detail = (validateDefinition.errors ?? [])
          .map((e) => `${e.instancePath} ${e.message ?? ""}`.trim())
          .join("; ");
        rejected.push(`${family}/${definition.name}: ${detail}`);
      }
    }

    expect(rejected).toEqual([]);
  });

  it("projects each Tool's declared authorization actions", () => {
    const incoherent: string[] = [];

    for (const { family, definition } of allDefinitions()) {
      const declared = definition.authorization.action;
      const declaredRequired = definition.authorization.requiredActions ?? [declared];
      const projected = toolContractSpecOf(definition);
      const requiredActions = projected.requiredActions ?? [];

      if (projected.action !== declared) {
        incoherent.push(`${family}/${definition.name}: action ${projected.action} !== ${declared}`);
      }

      if (!sameStrings(requiredActions, declaredRequired)) {
        incoherent.push(
          `${family}/${definition.name}: requiredActions ${JSON.stringify(
            requiredActions
          )} !== ${JSON.stringify(declaredRequired)}`
        );
      }
    }

    expect(incoherent).toEqual([]);
  });
});

describe("every Tool's authority is expressible as a grant", () => {
  const grantableTypes = new Set<string>(
    DEPLOYMENT_ROLES.flatMap((role) =>
      role.grants.filter((grant) => grant.effect === "allow").map((grant) => grant.resourceType)
    )
  );

  // Reshaping the business (Agents, Routines, Skills, Surface Components) needs an explicit
  // Team-level grant; a Team with no grants must not
  // give its members default access, so these resources carry no built-in Role allow (#access-audit).
  const OPERATOR_AUTHORED_RESOURCES = new Set([
    "soul.agent",
    "soul.routine",
    "soul.skill",
    "soul.surface_component",
  ]);

  it("declares no resource that no built-in Role can grant", () => {
    const ungrantable = new Set<string>();
    for (const { definition } of allDefinitions()) {
      for (const resource of definition.authorization.resources ?? []) {
        if (grantableTypes.has(resource) || OPERATOR_AUTHORED_RESOURCES.has(resource)) continue;
        ungrantable.add(`${definition.name}: ${resource}`);
      }
    }
    expect([...ungrantable].sort()).toEqual([]);
  });

  it("derives no target type outside the resource its Tool declares", () => {
    const escaped: string[] = [];
    for (const { definition } of allDefinitions()) {
      const declared = new Set(definition.authorization.resources ?? []);
      if (declared.size === 0) continue;
      for (const args of PROBE_ARGUMENTS) {
        let derived: readonly { type: string }[];
        try {
          derived = definition.targetsFor(args);
        } catch {
          continue;
        }
        for (const target of derived) {
          const coherent =
            declared.has(target.type) ||
            [...declared].some((resource) => target.type.startsWith(`${resource}.`));
          if (!coherent) escaped.push(`${definition.name}: ${target.type}`);
        }
      }
    }
    expect([...new Set(escaped)].sort()).toEqual([]);
  });

  it("declares a data class on every Tool, and a chat DLP rule for every class declared", () => {
    const permitted = new Set(CHAT_DLP_RULES.map((rule) => rule.dataClass));
    const unclassified: string[] = [];
    const unpermitted: string[] = [];
    for (const { definition } of allDefinitions()) {
      const classes = definition.authorization.dataClasses ?? [];
      if (classes.length === 0) {
        unclassified.push(definition.name);
        continue;
      }
      for (const dataClass of classes) {
        if (!permitted.has(dataClass)) unpermitted.push(`${definition.name}: ${dataClass}`);
      }
    }
    expect(unclassified.sort()).toEqual([]);
    expect([...new Set(unpermitted)].sort()).toEqual([]);
  });

  it("keeps surface-bound Tools declaring the surface they need", () => {
    const availability = new Map(
      allDefinitions().map(({ definition }) => [definition.name, definition.availableTo])
    );
    for (const name of ["present", "update_presentation", "request_input"]) {
      expect(availability.get(name)?.requiresPresentation, name).toBe(true);
    }
    for (const name of ["get_client_context", "navigate_to", "prefill_form", "invoke_action"]) {
      expect(availability.get(name)?.requiresWebChat, name).toBe(true);
    }
  });
});
