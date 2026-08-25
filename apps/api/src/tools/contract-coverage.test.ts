/** Ratchet: every registered Tool must declare authority or the build fails. */

import {
  type EgressHttpPort,
  GITHUB_TOOL_CONTRACTS,
  GOOGLE_TOOL_CONTRACTS,
  SLACK_TOOL_CONTRACTS,
} from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import type { Logger, SoulIntegration } from "@tulipfarm/soul";
import type { ChannelMentionedThreadStore } from "@tulipfarm/storage";
import {
  type CredentialDispatcher,
  MemoryEffectStore,
  RESOURCE_NAME_PATTERN,
  type ToolAdapter,
} from "@tulipfarm/tool-broker";
import type { ParkableToolDef, ToolDef } from "@tulipfarm/tool-host";
import { ledgerOwnsCall, toToolDef } from "@tulipfarm/tool-host";
import { describe, expect, it } from "vitest";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { IntegrationConversationsRepo } from "../ingress/repo";
import { DeclarativeToolSync } from "./declarative/sync";
import { declarativeToolName } from "./declarative/tools";
import type { GitHubInstallationDirectory } from "./github/installation";
import { buildGitHubTools, GITHUB_REPOSITORY_LIST_TOOL_NAME } from "./github/tools";
import { buildGoogleTools } from "./google/tools";
import { NETWORK_TOOLS } from "./network/tools";
import { buildToolRegistry } from "./setup";
import { buildSlackTools } from "./slack/tools";

type RegistryServices = Parameters<typeof buildToolRegistry>[0];

const BUSINESS_ID = "fitness-check-business";
const RESOURCE_GRAMMAR = new RegExp(RESOURCE_NAME_PATTERN);
const INVALID_REF_FRAGMENTS = ["undefined", "null"] as const;
// A synthetic manifest-driven integration exercises the declarative sync path without depending on
// any shipped integration, so removing a bundled provider cannot silently drop this coverage.
const DECLARATIVE_FITNESS_SLUG = "fitness-docs";
const DECLARATIVE_READ_DOCUMENT_TOOL_NAME = declarativeToolName(
  DECLARATIVE_FITNESS_SLUG,
  "read_document"
);

const ALWAYS_ON_TOOL_NAMES = [
  "get_client_context",
  "invoke_action",
  "navigate_to",
  "prefill_form",
  "present",
  "request_input",
  "update_presentation",
] as const;

const EXPECTED_FAMILY_TOOL_NAMES = [
  { family: "memory", names: ["get_memory", "update_memory"] },
  { family: "kv", names: ["kv_delete", "kv_get", "kv_list", "kv_set"] },
  { family: "files", names: ["file_list", "file_read", "file_create"] },
  {
    family: "knowledge",
    names: [
      "cite_sources",
      "create_knowledge_page",
      "list_governance_pages",
      "create_space",
      "get_backlinks",
      "get_page",
      "get_page_by_path",
      "get_space_graph",
      "list_spaces",
      "navigate_space",
      "query_knowledge",
      "write_page",
    ],
  },
  {
    family: "resources",
    names: [
      "record_create",
      "record_delete",
      "record_get",
      "record_list",
      "record_search",
      "record_update",
    ],
  },
  {
    family: "resource-types",
    names: [
      "create_resource_hooks",
      "create_resource_type",
      "list_resource_types",
      "resource_hooks_delete",
      "resource_hooks_get",
      "resource_type_schema",
      "resource_type_update",
    ],
  },
  {
    family: "agents",
    names: [
      "agent_create",
      "agent_delete",
      "agent_get",
      "agent_list",
      "agent_update",
      "get_business_profile",
      "get_current_agent",
    ],
  },
  {
    family: "skills",
    names: [
      "skill_activate",
      "skill_create",
      "skill_delete",
      "skill_get",
      "skill_install",
      "skill_list",
      "skill_marketplace_browse",
      "skill_scanned_audit",
      "skill_scanned_install",
      "skill_source_scan",
      "skill_update",
    ],
  },
  {
    family: "surface-components",
    names: [
      "surface_component_create",
      "surface_component_get",
      "surface_component_list",
      "surface_component_update",
    ],
  },
  {
    family: "platform",
    names: [
      "complete_state",
      "complete_task",
      "delegate_to_agent",
      "get_current_time",
      "guardrail_forge",
      "routine_delete",
      "routine_forge",
      "routine_picker",
      "skill",
      "soul_repo_push",
      "spawn_subagent",
      "trigger_routine",
      "validate_artifact",
    ],
  },
  { family: "network", names: ["api_request", "web_fetch"] },
  {
    family: "github",
    names: [
      "github_check_run_read",
      "github_content_list",
      "github_content_read",
      "github_issue_assign",
      "github_issue_close",
      "github_issue_comment",
      "github_issue_create",
      "github_issue_label",
      "github_issue_read",
      "github_issue_search",
      "github_pull_request_comment",
      "github_pull_request_create",
      "github_pull_request_merge",
      "github_pull_request_read",
      "github_pull_request_review",
      "github_pull_request_search",
      "github_repo_push",
      "github_repository_create",
      "github_repository_list",
    ],
  },
  { family: "slack", names: ["send_slack_message", "slack_channel_list"] },
  {
    family: "google",
    names: [
      "calendar_create_event",
      "calendar_delete_event",
      "calendar_list_events",
      "calendar_update_event",
      "docs_append",
      "docs_create",
      "docs_read",
      "drive_search",
      "gmail_draft",
      "gmail_read",
      "gmail_search",
    ],
  },
  {
    family: `declarative/${DECLARATIVE_FITNESS_SLUG}`,
    names: [DECLARATIVE_READ_DOCUMENT_TOOL_NAME],
  },
] as const;

const EXPECTED_TOTAL_TOOL_COUNT =
  ALWAYS_ON_TOOL_NAMES.length +
  EXPECTED_FAMILY_TOOL_NAMES.reduce((sum, family) => sum + family.names.length, 0);

const EXPECTED_CREDENTIAL_MODES_BY_PROVIDER = {
  github: "user_preferred",
  google: "service",
  [DECLARATIVE_FITNESS_SLUG]: "service",
  slack: "service",
} as const;

const PUBLISHED_DESTINATIONS_BY_ACTION = new Map(
  [...GITHUB_TOOL_CONTRACTS, ...SLACK_TOOL_CONTRACTS, ...GOOGLE_TOOL_CONTRACTS].map((contract) => [
    contract.spec.action,
    contract.spec.allowedDestinations,
  ])
);

const WRONG_TYPED_VALUES = [
  { label: "string", value: "wrong" },
  { label: "array", value: ["wrong"] },
  { label: "object", value: { value: "wrong" } },
  { label: "number", value: 7 },
  { label: "null", value: null },
  { label: "nested-object", value: { nested: { value: "wrong" } } },
] as const;

function throwOnExecute(): never {
  throw new Error("fitness check must not execute Tools");
}

function inert<T>(): T {
  return new Proxy(
    {},
    {
      get: () => () => throwOnExecute(),
    }
  ) as T;
}

function stubbedCoreServices(): RegistryServices {
  const stub = inert<never>();
  return {
    memoryDocuments: stub,
    kv: stub,
    files: stub,
    knowledge: stub,
    resources: stub,
    resourceTypes: stub,
    agentTools: stub,
    skillTools: stub,
    surfaceComponents: stub,
    platform: stub,
  };
}

function buildGitHubFitnessTools(): readonly ToolDef[] {
  return buildGitHubTools(BUSINESS_ID, {
    effects: new MemoryEffectStore(),
    adapters: new Map<string, ToolAdapter>(),
    credentials: inert<CredentialDispatcher>(),
    installations: inert<GitHubInstallationDirectory>(),
  });
}

function buildSlackFitnessTools(): readonly ToolDef[] {
  return buildSlackTools(BUSINESS_ID, {
    effects: new MemoryEffectStore(),
    adapters: new Map<string, ToolAdapter>(),
    credentials: inert<CredentialDispatcher>(),
    threads: inert<IntegrationConversationsRepo>(),
    mentionedThreads: inert<ChannelMentionedThreadStore>(),
  });
}

function buildGoogleFitnessTools(): readonly ToolDef[] {
  return buildGoogleTools(BUSINESS_ID, {
    effects: new MemoryEffectStore(),
    adapters: new Map<string, ToolAdapter>(),
    credentials: inert<CredentialDispatcher>(),
  });
}

const DECLARATIVE_FITNESS_SPEC = {
  openapi: "3.0.3",
  servers: [{ url: "https://api.fitness-docs.test/v1" }],
  paths: {
    "/documents/{document_id}": {
      get: {
        operationId: "readDocument",
        parameters: [
          { name: "document_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
  },
};

/** An inline manifest-driven integration, so the declarative sync path is covered on its own terms. */
function buildDeclarativeFitnessIntegration(): SoulIntegration {
  return {
    slug: DECLARATIVE_FITNESS_SLUG,
    sourceIntegration: DECLARATIVE_FITNESS_SLUG,
    manifest: {
      name: DECLARATIVE_FITNESS_SLUG,
      version: "1.0.0",
      description: "",
      egress: {
        type: "openapi",
        spec: "spec.json",
        operations: [
          { operation: "readDocument", name: "read_document", description: "Read one document." },
        ],
        auth: { token_env: "FITNESS_DOCS_TOKEN" },
      },
    } as SoulIntegration["manifest"],
    connection: { enabled: true, env: {} },
    egressSpec: DECLARATIVE_FITNESS_SPEC,
  };
}

interface CoveredTools {
  readonly tools: readonly ParkableToolDef[];
  readonly declarativeCount: number;
  readonly declarativeProblems: readonly string[];
}

/** Builds the production registry with stubs so service-gated Tool families are still covered. */
function registerAllFamilies(): CoveredTools {
  const registry = buildToolRegistry({
    ...stubbedCoreServices(),
    github: buildGitHubFitnessTools(),
    slack: buildSlackFitnessTools(),
    google: buildGoogleFitnessTools(),
    network: NETWORK_TOOLS.map((definition) => toToolDef(definition, () => inert<never>())),
  });

  const declarativeProblems: string[] = [];
  const logger: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: (message) => declarativeProblems.push(message),
  };
  const sync = new DeclarativeToolSync({
    registry: registry as ToolRegistry,
    integrations: () => [buildDeclarativeFitnessIntegration()],
    businessId: BUSINESS_ID,
    effects: new MemoryEffectStore(),
    secrets: async () => inert<SecretsService>(),
    http: inert<EgressHttpPort>(),
    logger: () => logger,
  });
  const declarativeCount = sync.sync();

  return { tools: registry.getAll(), declarativeCount, declarativeProblems };
}

function sortedToolNames(tools: readonly ParkableToolDef[]): readonly string[] {
  return tools.map((tool) => tool.name).sort();
}

function registryNames(services: RegistryServices): readonly string[] {
  return sortedToolNames(buildToolRegistry(services).getAll());
}

function withoutAlwaysOn(names: readonly string[]): readonly string[] {
  const always = new Set<string>(ALWAYS_ON_TOOL_NAMES);
  return names.filter((name) => !always.has(name));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function collectSchemaFieldNames(schema: unknown, names = new Set<string>()): Set<string> {
  const source = record(schema);
  if (source === undefined) return names;

  const properties = record(source.properties);
  if (properties !== undefined) {
    for (const [name, child] of Object.entries(properties)) {
      names.add(name);
      collectSchemaFieldNames(child, names);
    }
  }

  for (const name of stringArray(source.required)) {
    names.add(name);
  }

  collectSchemaFieldNames(source.items, names);
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    for (const child of Array.isArray(source[keyword]) ? source[keyword] : []) {
      collectSchemaFieldNames(child, names);
    }
  }

  return names;
}

interface Probe {
  readonly label: string;
  readonly args: unknown;
}

function targetProbesFor(tool: ParkableToolDef): readonly Probe[] {
  const fieldNames = [...collectSchemaFieldNames(tool.inputSchema)].sort();
  const probes: Probe[] = [
    { label: "empty-object", args: {} },
    { label: "unexpected-property", args: { unexpected: true } },
    { label: "arbitrary-array-root", args: ["unexpected"] },
    { label: "arbitrary-string-root", args: "unexpected" },
    { label: "arbitrary-null-root", args: null },
    {
      label: "arbitrary-nested-shape",
      args: { unexpected: { nested: { value: "wrong" } }, body: { parent: { id: "wrong" } } },
    },
  ];

  for (const field of fieldNames) {
    for (const { label, value } of WRONG_TYPED_VALUES) {
      probes.push({ label: `${field}:${label}:direct`, args: { [field]: value } });
      probes.push({ label: `${field}:${label}:body`, args: { body: { [field]: value } } });
      probes.push({
        label: `${field}:${label}:body-parent`,
        args: { body: { parent: { [field]: value } } },
      });
    }
  }

  return probes;
}

function targetRefProblem(ref: unknown): string | undefined {
  const source = record(ref);
  const type = source?.type;
  const id = source?.id;
  if (typeof type !== "string") return `non-string type ${JSON.stringify(type)}`;
  if (typeof id !== "string") return `non-string id ${JSON.stringify(id)}`;
  if (type.length === 0) return "empty type";
  if (id.length === 0) return "empty id";
  for (const fragment of INVALID_REF_FRAGMENTS) {
    if (type.includes(fragment)) return `type contains ${fragment}: ${type}`;
    if (id.includes(fragment)) return `id contains ${fragment}: ${id}`;
  }
  return undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

function expectedCredentialModeFor(provider: string): string | undefined {
  switch (provider) {
    case "github":
      return EXPECTED_CREDENTIAL_MODES_BY_PROVIDER.github;
    case "google":
      return EXPECTED_CREDENTIAL_MODES_BY_PROVIDER.google;
    case DECLARATIVE_FITNESS_SLUG:
      return EXPECTED_CREDENTIAL_MODES_BY_PROVIDER[DECLARATIVE_FITNESS_SLUG];
    case "slack":
      return EXPECTED_CREDENTIAL_MODES_BY_PROVIDER.slack;
    default:
      return undefined;
  }
}

describe("tool contract coverage", () => {
  const coverage = registerAllFamilies();
  const tools = coverage.tools;
  const toolNames = new Set(tools.map((tool) => tool.name));

  it("registers the full tool surface by family", () => {
    const duplicateNames = sortedToolNames(tools).filter(
      (name, index, names) => index > 0 && names[index - 1] === name
    );
    expect(duplicateNames, "duplicate Tool registrations").toEqual([]);
    expect(coverage.declarativeProblems, "declarative Tool fixture failed to publish").toEqual([]);
    expect(coverage.declarativeCount, "declarative fixture published Tool count").toBe(1);

    for (const name of ALWAYS_ON_TOOL_NAMES) {
      expect(toolNames.has(name), `always-on Tool missing: ${name}`).toBe(true);
    }

    for (const { family, names } of EXPECTED_FAMILY_TOOL_NAMES) {
      const missing = names.filter((name) => !toolNames.has(name));
      expect(missing, `${family} Tool family missing registrations`).toEqual([]);
    }

    expect(tools.length, "total registered Tool count").toBe(EXPECTED_TOTAL_TOOL_COUNT);
  });

  it("registers the whole memory family from the document repository alone", () => {
    expect(withoutAlwaysOn(registryNames({ memoryDocuments: inert<never>() }))).toEqual([
      "get_memory",
      "update_memory",
    ]);
  });

  it("gives every registered Tool a declaration the gate can read", () => {
    const undeclared = tools.filter((tool) => tool.definition === undefined).map((t) => t.name);
    expect(undeclared).toEqual([]);
  });

  it("keeps the registry name and declaration name identical", () => {
    const mismatched = tools.flatMap((tool) =>
      tool.definition !== undefined && tool.definition.name !== tool.name
        ? [`${tool.name}: definition.name is ${tool.definition.name}`]
        : []
    );
    expect(mismatched).toEqual([]);
  });

  it("gives every Tool an action to authorize against", () => {
    const actionless = tools
      .filter((tool) => (tool.definition?.authorization.action ?? "").length === 0)
      .map((t) => t.name);
    expect(actionless).toEqual([]);
  });

  // The ticket's demand, stated as a test rather than as a belief: an Agent must not be able to
  // widen who can read a File. Sharing is a decision a person makes about their own upload, and an
  // Agent reads attachments from untrusted sources — a Tool that shares is a Tool that a crafted
  // PDF can aim. If sharing ever needs to be agentic, this test is where that argument gets made.
  it("gives no Tool any way to share a File or read another Principal's", () => {
    const reachesSharing = tools.filter((tool) => {
      const authorization = tool.definition?.authorization;
      const surface = [
        tool.name,
        authorization?.action ?? "",
        ...(authorization?.resources ?? []),
      ].join(" ");
      return /\bfile[._-]?share|share[._-]?file|file\.(share|unshare)/i.test(surface);
    });
    expect(reachesSharing.map((tool) => tool.name)).toEqual([]);

    // `navigate_to` sends a person to an app path; it cannot call the API. Everything else that
    // holds a URL takes it from an Integration manifest, which is authored per provider and can
    // only name that provider's host. Neither can reach a first-party route, and this asserts the
    // property that makes that true rather than re-listing the routes.
    const firstPartyCallers = tools.filter((tool) =>
      [JSON.stringify(tool.inputSchema), tool.description].join(" ").includes("/api/v1/files")
    );
    expect(firstPartyCallers.map((tool) => tool.name)).toEqual([]);
  });

  // Same argument as sharing, one step further: destruction is irreversible and there is no
  // versioning behind it. An Agent that could delete a File on instruction would turn a crafted
  // attachment into a way to destroy the very evidence of it. Deletion stays a person's act.
  it("gives no Tool any way to delete a File", () => {
    const reachesDeletion = tools.filter((tool) => {
      const authorization = tool.definition?.authorization;
      const surface = [
        tool.name,
        authorization?.action ?? "",
        ...(authorization?.resources ?? []),
      ].join(" ");
      return /\bfile[._-]?(delete|destroy|erase|remove)|(delete|destroy|erase|remove)[._-]?file/i.test(
        surface
      );
    });
    expect(reachesDeletion.map((tool) => tool.name)).toEqual([]);
  });

  // A Turn sends a File only on the Turn it was attached to, so an Agent needs a way back to it —
  // and that way must not be a way to anything else. List, read and create are the whole surface.
  // Creating is admitted because it makes a File nobody had a claim on yet; every verb that
  // changes who can reach a File that already exists is not. The two ratchets above prove that
  // negative across every Tool; this proves the positive about the family that exists to touch
  // Files, so adding a fourth `file_*` verb has to be an argued decision rather than a slip.
  it("gives Agents Files to list, read and create, and nothing else to do with them", () => {
    const fileTools = tools.filter((tool) => tool.name.startsWith("file_"));
    expect(fileTools.map((tool) => tool.name).sort()).toEqual([
      "file_create",
      "file_list",
      "file_read",
    ]);
    expect(fileTools.filter((tool) => tool.mutating === true).map((tool) => tool.name)).toEqual([
      "file_create",
    ]);
    expect(fileTools.map((tool) => tool.definition?.authorization.action).sort()).toEqual([
      "file.create",
      "file.list",
      "file.read",
    ]);
  });

  // Ownership is the whole reason a Routine's monthly report survives the offboarding of whoever
  // scheduled it. An input the Agent controls that names an owner would hand that decision back to
  // the model, so the schema must have no way to express one.
  it("gives the Agent no way to say who owns what it creates", () => {
    const create = tools.find((tool) => tool.name === "file_create");
    const schema = JSON.stringify(create?.inputSchema ?? {});
    expect(create).toBeDefined();
    expect(schema).not.toMatch(/owner|principal|shareWith|readableBy/i);
    // Without this an unknown property is dropped in silence rather than refused.
    expect((create?.inputSchema as { additionalProperties?: boolean })?.additionalProperties).toBe(
      false
    );
  });

  it("keeps every declared resource inside the two-level grammar", () => {
    const offenders = tools.flatMap((tool) =>
      (tool.definition?.authorization.resources ?? [])
        .filter((resource) => !RESOURCE_GRAMMAR.test(resource))
        .map((resource) => `${tool.name}: ${resource}`)
    );
    expect(offenders).toEqual([]);
  });

  it("keeps integration destinations aligned with their published contracts", () => {
    const offenders = tools.flatMap((tool) => {
      const definition = tool.definition;
      if (definition === undefined) return [];
      const expected = PUBLISHED_DESTINATIONS_BY_ACTION.get(definition.authorization.action);
      if (expected === undefined) return [];
      const actual = definition.authorization.allowedDestinations ?? [];
      return sameStrings(sortedStrings(actual), sortedStrings(expected))
        ? []
        : [
            `${tool.name}: destinations ${JSON.stringify(actual)} do not match contract ` +
              JSON.stringify(expected),
          ];
    });
    expect(offenders).toEqual([]);
  });

  it("leaves no mutating Tool without an idempotency story", () => {
    // A mutating Tool that cannot absorb a duplicate delivery cannot be safely dispatched: the
    // dispatcher cannot distinguish a lost response from a lost request.
    const unsafe = tools
      .filter((tool) => tool.mutating && tool.definition?.idempotency === "none")
      .map((t) => t.name);
    expect(unsafe).toEqual([]);
  });

  it("routes every mutating Tool through exactly one effect ledger", () => {
    // `s6-fitness`, second half. A mutating Tool reaches the world, so a duplicate delivery of the
    // same tool call must not apply its write twice. Exactly one layer may own that reservation:
    // a provider-backed Tool reserves inside its own executor (where the dispatch *phase* is
    // visible), and every other mutating Tool is reserved by the chat dispatcher through
    // `ledgerOwnsCall`. Both would open two effects for one write; neither leaves the write naked.
    //
    // This is a ratchet. The failure mode of a Tool that slips out of both is silence — it works,
    // it is reachable by a model, and it double-applies only when a delivery is repeated.
    const unowned = tools
      .filter((tool) => tool.mutating)
      .filter((tool) => {
        const dispatcherOwns = ledgerOwnsCall(tool.definition);
        const executorOwns = tool.definition?.provider !== undefined;
        return dispatcherOwns === executorOwns;
      })
      .map((tool) => tool.name);
    expect(unowned).toEqual([]);
  });

  it("uses the expected credential mode for every provider-backed Tool", () => {
    const offenders = tools.flatMap((tool) => {
      const definition = tool.definition;
      if (definition?.provider === undefined) return [];
      const expected =
        tool.name === GITHUB_REPOSITORY_LIST_TOOL_NAME
          ? "service"
          : expectedCredentialModeFor(definition.provider);
      if (expected === undefined) {
        return [`${tool.name}: provider ${definition.provider} has no expected credential mode`];
      }
      return definition.credentialMode === expected
        ? []
        : [`${tool.name}: credentialMode ${definition.credentialMode} should be ${expected}`];
    });
    expect(offenders).toEqual([]);
  });

  it("keeps target derivation total and well-formed across every Tool", () => {
    const offenders: string[] = [];

    for (const tool of tools) {
      const definition = tool.definition;
      if (definition === undefined) {
        offenders.push(`${tool.name}: missing definition`);
        continue;
      }

      for (const probe of targetProbesFor(tool)) {
        let targets: readonly unknown[];
        try {
          targets = definition.targetsFor(probe.args) as readonly unknown[];
        } catch (error) {
          offenders.push(
            `${tool.name}: targetsFor threw for ${probe.label}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          continue;
        }

        targets.forEach((target, index) => {
          const problem = targetRefProblem(target);
          if (problem !== undefined) {
            offenders.push(`${tool.name}: ${probe.label} target[${index}] ${problem}`);
          }
        });
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps GitHub searches on one explicit repository target", () => {
    const offenders = tools
      .filter(
        (tool) => tool.name === "github_issue_search" || tool.name === "github_pull_request_search"
      )
      .flatMap((tool) => {
        const targets = tool.definition?.targetsFor({ repository: "acme/api" }) ?? [];
        const schema = record(tool.inputSchema);
        const required = schema?.required;
        const properties = record(schema?.properties);
        return targets.length === 1 &&
          targetRefProblem(targets[0]) === undefined &&
          Array.isArray(required) &&
          required.includes("repository") &&
          properties?.repositories === undefined
          ? []
          : [`${tool.name}: search must require one repository and derive one target`];
      });
    expect(offenders).toEqual([]);
  });
});
