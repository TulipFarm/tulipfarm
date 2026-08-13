/**
 * Stage 1 fitness check: every registered Tool declares its own authority.
 *
 * This is a ratchet, not a unit test. Before `defineTool` existed, a Tool had nowhere to say what
 * authority a call to it required, so the gate had nothing to decide on. Now that every Tool can
 * say it, the only thing keeping that true over time is a check that fails the build when a new
 * Tool is registered without a declaration.
 *
 * Without this, the twelfth tool module added six months from now quietly reintroduces the gap:
 * it registers, it works, it is reachable by a model, and it is invisible to policy. The failure
 * mode of a missing declaration is not an error — it is silence.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EgressHttpPort,
  GITHUB_TOOL_CONTRACTS,
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
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { IntegrationConversationsRepo } from "../ingress/repo";
import { ledgerOwnsCall } from "../internal/effect-ledger";
import { DeclarativeToolSync } from "./declarative/sync";
import { declarativeToolName } from "./declarative/tools";
import type { GitHubInstallationDirectory } from "./github/installation";
import { buildGitHubTools } from "./github/tools";
import { buildToolRegistry } from "./setup";
import { buildSlackTools } from "./slack/tools";
import type { ToolDef } from "./types";

type RegistryServices = Parameters<typeof buildToolRegistry>[0];

const BUSINESS_ID = "fitness-check-business";
const RESOURCE_GRAMMAR = new RegExp(RESOURCE_NAME_PATTERN);
const INVALID_REF_FRAGMENTS = ["undefined", "null"] as const;
const GOOGLE_DOCS_READ_DOCUMENT_TOOL_NAME = declarativeToolName("google-docs", "read_document");

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
  {
    family: "memory",
    names: ["delete_memory", "recall_memory", "remember_correction", "update_memory"],
  },
  { family: "kv", names: ["kv_delete", "kv_get", "kv_list", "kv_set"] },
  {
    family: "knowledge",
    names: [
      "cite_sources",
      "create_knowledge_page",
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
    names: ["agent_create", "agent_delete", "agent_get", "agent_list", "agent_update"],
  },
  {
    family: "skills",
    names: [
      "skill_activate",
      "skill_create",
      "skill_delete",
      "skill_get",
      "skill_list",
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
      "begin_soul_batch",
      "call_skill",
      "complete_state",
      "complete_task",
      "delegate_to_agent",
      "end_soul_batch",
      "get_current_time",
      "load_skill",
      "load_skill_reference",
      "routine_forge",
      "routine_picker",
      "soul_repo_commit",
      "soul_repo_push",
      "transfer_to_agent",
      "trigger_routine",
      "validate_artifact",
    ],
  },
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
  { family: "slack", names: ["send_slack_message"] },
  { family: "declarative/google-docs", names: [GOOGLE_DOCS_READ_DOCUMENT_TOOL_NAME] },
] as const;

const EXPECTED_TOTAL_TOOL_COUNT =
  ALWAYS_ON_TOOL_NAMES.length +
  EXPECTED_FAMILY_TOOL_NAMES.reduce((sum, family) => sum + family.names.length, 0);

const EXPECTED_MEMORY_WITHOUT_OPTIONAL_SERVICES = ["delete_memory", "update_memory"] as const;
const EXPECTED_MEMORY_WITH_ALL_SERVICES = [
  "delete_memory",
  "recall_memory",
  "remember_correction",
  "update_memory",
] as const;

const EXPECTED_CREDENTIAL_MODES_BY_PROVIDER = {
  github: "user_preferred",
  "google-docs": "service",
  slack: "service",
} as const;

const PUBLISHED_DESTINATIONS_BY_ACTION = new Map(
  [...GITHUB_TOOL_CONTRACTS, ...SLACK_TOOL_CONTRACTS].map((contract) => [
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

function readGoogleDocsIntegration(): SoulIntegration {
  const integrationDir = join(process.cwd(), "../../integrations/google-docs");
  const manifest = parseYaml(readFileSync(join(integrationDir, "manifest.yml"), "utf8"));
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("google-docs fixture manifest must be a YAML mapping");
  }
  const egressSpec: unknown = JSON.parse(
    readFileSync(join(integrationDir, "openapi.json"), "utf8")
  );
  return {
    slug: "google-docs",
    sourceIntegration: "google-docs",
    manifest: manifest as SoulIntegration["manifest"],
    connection: {
      enabled: true,
      env: { GOOGLE_DOCS_ACCESS_TOKEN: "secret://integrations/google-docs/token" },
    },
    egressSpec,
  };
}

interface CoveredTools {
  readonly tools: readonly ToolDef[];
  readonly declarativeCount: number;
  readonly declarativeProblems: readonly string[];
}

/**
 * Builds the registry the way production does, with every optional service wired to a stub.
 *
 * The stubs are never called: this file inspects declarations, it does not execute Tools. They
 * exist only because `buildToolRegistry` registers a family only when its service is present, and
 * a check that skipped unwired families would be a coverage check with a hole in exactly the shape
 * of whatever was hardest to construct.
 */
function registerAllFamilies(): CoveredTools {
  const registry = buildToolRegistry({
    ...stubbedCoreServices(),
    github: buildGitHubFitnessTools(),
    slack: buildSlackFitnessTools(),
  });

  const declarativeProblems: string[] = [];
  const logger: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: (message) => declarativeProblems.push(message),
  };
  const sync = new DeclarativeToolSync({
    registry: registry as ToolRegistry,
    integrations: () => [readGoogleDocsIntegration()],
    businessId: BUSINESS_ID,
    effects: new MemoryEffectStore(),
    secrets: async () => inert<SecretsService>(),
    http: inert<EgressHttpPort>(),
    logger: () => logger,
  });
  const declarativeCount = sync.sync();

  return { tools: registry.getAll(), declarativeCount, declarativeProblems };
}

function sortedToolNames(tools: readonly ToolDef[]): readonly string[] {
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

function targetProbesFor(tool: ToolDef): readonly Probe[] {
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
    case "google-docs":
      return EXPECTED_CREDENTIAL_MODES_BY_PROVIDER["google-docs"];
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
    expect(coverage.declarativeCount, "declarative/google-docs published Tool count").toBe(1);

    for (const name of ALWAYS_ON_TOOL_NAMES) {
      expect(toolNames.has(name), `always-on Tool missing: ${name}`).toBe(true);
    }

    for (const { family, names } of EXPECTED_FAMILY_TOOL_NAMES) {
      const missing = names.filter((name) => !toolNames.has(name));
      expect(missing, `${family} Tool family missing registrations`).toEqual([]);
    }

    expect(tools.length, "total registered Tool count").toBe(EXPECTED_TOTAL_TOOL_COUNT);
  });

  it("keeps the memory family shape explicit when optional services are absent or present", () => {
    const memoryOnlyNames = withoutAlwaysOn(registryNames({ memory: inert<never>() }));
    expect(memoryOnlyNames, "memory without recall/lifecycle services").toEqual(
      EXPECTED_MEMORY_WITHOUT_OPTIONAL_SERVICES
    );

    const memoryWithAllServicesNames = withoutAlwaysOn(
      registryNames({
        memory: inert<never>(),
        memoryRecall: inert<never>(),
        memoryLifecycle: inert<never>(),
      })
    );
    expect(memoryWithAllServicesNames, "memory with recall/lifecycle services").toEqual(
      EXPECTED_MEMORY_WITH_ALL_SERVICES
    );
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
      const expected = expectedCredentialModeFor(definition.provider);
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

  it("does not collapse all-repository GitHub searches to no target", () => {
    const offenders = tools
      .filter(
        (tool) => tool.name === "github_issue_search" || tool.name === "github_pull_request_search"
      )
      .filter((tool) => (tool.definition?.targetsFor({}) ?? []).length === 0)
      .map((tool) => `${tool.name}: omitting repository searches all installed repositories`);
    expect(offenders).toEqual([]);
  });
});
