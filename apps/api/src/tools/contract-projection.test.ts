import type { EgressHttpPort, EgressHttpRequest } from "@tulipfarm/integrations";
import { ajv, ToolContractDefinitionSchema } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationManifest, SoulIntegration } from "@tulipfarm/soul";
import type { ChannelMentionedThreadStore } from "@tulipfarm/storage";
import {
  type CredentialDispatcher,
  MemoryEffectStore,
  type ToolAdapter,
  toolContractSpecOf,
} from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import { DEPLOYMENT_ROLES } from "../identity/roles";
import type { IntegrationConversationsRepo } from "../ingress/repo";
import { CHAT_DLP_RULES } from "../internal/tool-gate";
import { buildDeclarativeTools } from "./declarative/tools";
import type { GitHubInstallationDirectory } from "./github/installation";
import { buildGitHubTools } from "./github/tools";
import { buildToolRegistry } from "./setup";
import { buildSlackTools } from "./slack/tools";
import type { ToolDef } from "./types";

const validateDefinition = ajv.compile(ToolContractDefinitionSchema);
const BUSINESS_ID = "contract-projection-business";

const SPEC = {
  openapi: "3.0.3",
  servers: [{ url: "https://api.acme.test/v1" }],
  paths: {
    "/search": {
      post: {
        operationId: "search",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/pages/{page_id}": {
      get: {
        operationId: "getPage",
        parameters: [{ name: "page_id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
  },
};

const SEARCH_OP = { operation: "search", name: "search_docs", description: "Search Acme docs." };
const READ_OP = { operation: "getPage", name: "read_page", description: "Read one page." };

interface LabeledDefinition {
  readonly family: string;
  readonly definition: NonNullable<ToolDef["definition"]>;
}

function throwOnExecute(): never {
  throw new Error("contract projection must not execute Tools");
}

function inert<T>(): T {
  return new Proxy(
    {},
    {
      get: () => () => throwOnExecute(),
    }
  ) as T;
}

function definitionsFrom(family: string, tools: readonly ToolDef[]): readonly LabeledDefinition[] {
  return tools.flatMap((tool) =>
    tool.definition === undefined ? [] : [{ family, definition: tool.definition }]
  );
}

function localDefinitions(): readonly LabeledDefinition[] {
  const stub = new Proxy({}, { get: () => () => throwOnExecute() }) as never;

  return definitionsFrom(
    "local",
    buildToolRegistry({
      memory: stub,
      memoryRecall: stub,
      memoryLifecycle: stub,
      kv: stub,
      knowledge: stub,
      resources: stub,
      resourceTypes: stub,
      agentTools: stub,
      skillTools: stub,
      surfaceComponents: stub,
      platform: stub,
    }).getAll()
  );
}

function githubDefinitions(): readonly LabeledDefinition[] {
  return definitionsFrom(
    "github",
    buildGitHubTools(BUSINESS_ID, {
      effects: new MemoryEffectStore(),
      adapters: new Map<string, ToolAdapter>(),
      credentials: inert<CredentialDispatcher>(),
      installations: inert<GitHubInstallationDirectory>(),
    })
  );
}

function slackDefinitions(): readonly LabeledDefinition[] {
  return definitionsFrom(
    "slack",
    buildSlackTools(BUSINESS_ID, {
      effects: new MemoryEffectStore(),
      adapters: new Map<string, ToolAdapter>(),
      credentials: inert<CredentialDispatcher>(),
      threads: inert<IntegrationConversationsRepo>(),
      mentionedThreads: inert<ChannelMentionedThreadStore>(),
    })
  );
}

function integration(egress: IntegrationManifest["egress"]): SoulIntegration {
  return {
    slug: "google-docs",
    sourceIntegration: "google-docs",
    manifest: {
      name: "google-docs",
      version: "1.0.0",
      description: "",
      egress,
    } as IntegrationManifest,
    egressSpec: SPEC,
  };
}

function openApiEgress(): IntegrationManifest["egress"] {
  return {
    type: "openapi",
    spec: "spec.json",
    operations: [SEARCH_OP, READ_OP],
    auth: { token_env: "GOOGLE_DOCS_ACCESS_TOKEN" },
  };
}

class RecordingHttp implements EgressHttpPort {
  readonly sent: EgressHttpRequest[] = [];

  async send(request: EgressHttpRequest) {
    this.sent.push(request);
    return { status: 200, headers: {}, body: { ok: true } };
  }
}

function secretsStub(): () => Promise<SecretsService> {
  const service = {
    get: async () => "unused",
  };
  return async () => service as unknown as SecretsService;
}

function declarativeDefinitions(): readonly LabeledDefinition[] {
  const { tools, problems } = buildDeclarativeTools([integration(openApiEgress())], {
    businessId: BUSINESS_ID,
    effects: new MemoryEffectStore(),
    secrets: secretsStub(),
    http: new RecordingHttp(),
  });

  if (problems.length > 0) {
    throw new Error(`declarative fixture failed to publish: ${problems.join("; ")}`);
  }

  return definitionsFrom("declarative", tools);
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
  return [
    ...localDefinitions(),
    ...githubDefinitions(),
    ...slackDefinitions(),
    ...declarativeDefinitions(),
  ];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

describe("published contract projection", () => {
  it("draws its corpus from every Tool family, in-house and imported alike", () => {
    const counts = new Map<string, number>();
    for (const { family } of allDefinitions()) {
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }

    for (const family of ["local", "github", "slack", "declarative"]) {
      expect
        .soft(counts.get(family) ?? 0, `${family} contributed no definitions`)
        .toBeGreaterThan(0);
    }
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

  it("projects the declared authorization action as the only required action", () => {
    const incoherent: string[] = [];
    const declarativeActions: string[] = [];

    for (const { family, definition } of allDefinitions()) {
      const declared = definition.authorization.action;
      const projected = toolContractSpecOf(definition);
      const requiredActions = projected.requiredActions ?? [];
      if (family === "declarative") declarativeActions.push(declared);

      if (projected.action !== declared) {
        incoherent.push(`${family}/${definition.name}: action ${projected.action} !== ${declared}`);
      }

      if (!sameStrings(requiredActions, [declared])) {
        incoherent.push(
          `${family}/${definition.name}: requiredActions ${JSON.stringify(
            requiredActions
          )} !== ${declared}`
        );
      }
    }

    expect(incoherent).toEqual([]);
    expect(declarativeActions.sort()).toEqual(["google_docs.read_page", "google_docs.search_docs"]);
  });
});

describe("every Tool's authority is expressible as a grant", () => {
  const grantableTypes = new Set<string>(
    DEPLOYMENT_ROLES.flatMap((role) =>
      role.grants.filter((grant) => grant.effect === "allow").map((grant) => grant.resourceType)
    )
  );

  const OPERATOR_AUTHORED_RESOURCES = new Set(["integration.google-docs"]);

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
