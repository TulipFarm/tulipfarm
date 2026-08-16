import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { ajv } from "@tulipfarm/schema";
import {
  type GitSyncService,
  type SoulWrite,
  SoulWriteError,
  type SoulWriter,
} from "@tulipfarm/soul";
import {
  type SoulSurfaceComponent,
  type SurfaceComponentSupport,
  validateSoulSurfaceComponent,
} from "@tulipfarm/surface";
import {
  type ApiToolDefinition,
  defineApiTool,
  err,
  ok,
  type RequestContext,
  type ToolCallResult,
} from "@tulipfarm/tool-host";
import { parse, stringify } from "yaml";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../../runtime/soul-writer";
import { soulCommitError } from "../../tools/soul-faults";

export interface SurfaceComponentToolContext {
  readonly gitSync: GitSyncService;
  readonly soulWriter: SoulWriter;
  readonly surfaceSupport?: SurfaceComponentSupport;
  readonly requestContext?: RequestContext;
}

const SLUG = "^[a-z][a-z0-9-]*$";
const SOUL_SURFACE_COMPONENT_TARGET = "soul.surface_component";
const TARGET = {
  type: "object",
  additionalProperties: false,
  required: ["channel", "surface"],
  properties: {
    channel: { enum: ["web", "slack", "telegram", "github"] },
    surface: { enum: ["chat", "message", "modal", "comment", "check-run"] },
  },
};
const EVENT = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "inputSchema"],
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    inputSchema: { type: "object" },
  },
};
const VIEW = {
  type: "object",
  description:
    "Declarative trusted-component composition. Values may use {$prop:'/pointer'} bindings.",
};
const DEFINITION = {
  type: "object",
  additionalProperties: false,
  required: [
    "slug",
    "version",
    "description",
    "propsSchema",
    "events",
    "examples",
    "targets",
    "views",
  ],
  properties: {
    slug: { type: "string", pattern: SLUG },
    version: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    propsSchema: { type: "object" },
    events: { type: "array", items: EVENT },
    examples: { type: "array", minItems: 1 },
    targets: { type: "array", minItems: 1, items: TARGET },
    views: {
      type: "object",
      additionalProperties: false,
      properties: {
        default: VIEW,
        web: VIEW,
        slack: VIEW,
        telegram: VIEW,
        github: VIEW,
      },
    },
  },
} as const;

const validateDefinition = ajv.compile(DEFINITION);

function root(context: SurfaceComponentToolContext): string {
  return join(context.gitSync.path, "surface-components");
}

function directory(context: SurfaceComponentToolContext, slug: string): string {
  return join(root(context), slug);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringArg(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function surfaceComponentTargets(args: unknown) {
  const id = stringArg(args, "slug");
  // Soul targets use the same two-level name as their static resource (`soul.<thing>`).
  return id === undefined ? [] : [{ type: SOUL_SURFACE_COMPONENT_TARGET, id }];
}

function validateComponent(
  value: unknown,
  surfaceSupport?: SurfaceComponentSupport
): ToolCallResult | null {
  if (!validateDefinition(value)) {
    const issue = validateDefinition.errors?.[0];
    return err(
      "validation_error",
      `${issue?.instancePath || "/"} ${issue?.message ?? "is invalid"}`
    );
  }
  const definition = value as {
    slug: string;
    propsSchema: Record<string, unknown>;
    examples: unknown[];
    targets: Array<{ channel: string; surface: string }>;
    views: Record<string, unknown>;
  };
  let validateProps: ReturnType<typeof ajv.compile>;
  try {
    validateProps = ajv.compile(definition.propsSchema);
  } catch (error) {
    return err("validation_error", `Invalid propsSchema: ${reason(error)}`);
  }
  for (const [index, example] of definition.examples.entries()) {
    if (!validateProps(example)) {
      return err("validation_error", `Example ${index} does not match propsSchema.`);
    }
  }
  const targetChannels = new Set(definition.targets.map((target) => target.channel));
  for (const channel of Object.keys(definition.views).filter((name) => name !== "default")) {
    if (!targetChannels.has(channel)) {
      return err("validation_error", `View "${channel}" has no declared target.`);
    }
  }
  const serialized = JSON.stringify(definition.views);
  if (/(<\/?[a-z]|javascript:|<script|@import)/i.test(serialized)) {
    return err(
      "validation_error",
      "Views may contain only trusted component composition, literals, and property bindings."
    );
  }
  try {
    validateSoulSurfaceComponent(
      {
        ...definition,
        name: `business.${definition.slug}`,
      } as unknown as SoulSurfaceComponent,
      surfaceSupport
    );
  } catch (error) {
    return err("validation_error", reason(error));
  }
  return null;
}

/**
 * Map a Soul write-gateway rejection onto the Surface component tools' error vocabulary.
 *
 * `PRECONDITION_FAILED` is the one code whose meaning is site-specific — an "already exists" on
 * create, a "not found" on update — so each caller supplies that mapping. The rest are fixed: a
 * rejected changeset (bad target or invalid definition) is a `validation_error`, a moved base is
 * transient (`unavailable`), and a failed commit is classified by `soulCommitError` so git
 * contention is reported as `unavailable` rather than as a request the model should repair. The
 * gateway's message carries only structured evidence, never file content, so it is safe to surface.
 */
function mapSurfaceWriteError(
  error: SoulWriteError,
  onPrecondition: () => ToolCallResult
): ToolCallResult {
  switch (error.code) {
    case "PRECONDITION_FAILED":
      return onPrecondition();
    case "VALIDATION_FAILED":
    case "INVALID_TARGET":
      return err("validation_error", error.message);
    case "CONFLICT":
      return err("unavailable", error.message);
    default:
      return soulCommitError(error, error.message);
  }
}

type ComponentValue = {
  slug: string;
  version: string;
  description: string;
  propsSchema: Record<string, unknown>;
  events: unknown[];
  examples: unknown[];
  targets: unknown[];
  views: Record<string, unknown>;
};

function componentDefinitionContent(value: ComponentValue): string {
  return stringify({
    name: `business.${value.slug}`,
    version: value.version,
    description: value.description,
    propsSchema: value.propsSchema,
    events: value.events,
    examples: value.examples,
    targets: value.targets,
    metadata: { protocol: "tsp", protocolVersion: "1.0" },
  });
}

/** The `.yaml` view files currently on disk beside the component, or `[]` when the dir is absent. */
async function existingViewFiles(
  context: SurfaceComponentToolContext,
  slug: string
): Promise<string[]> {
  try {
    const entries = await readdir(join(directory(context, slug), "views"));
    return entries.filter((entry) => entry.endsWith(".yaml"));
  } catch {
    // A missing views directory means there are no views to list.
    return [];
  }
}

/**
 * Build the single changeset that publishes a component: the definition, every desired view, and a
 * delete for any stale view file the new definition no longer declares — so the whole artifact
 * lands atomically instead of the previous mkdir + writeFile + unlink sequence.
 */
async function buildComponentChanges(
  context: SurfaceComponentToolContext,
  value: ComponentValue
): Promise<SoulWrite[]> {
  const changes: SoulWrite[] = [
    {
      op: "put",
      target: { kind: "SurfaceComponent", slug: value.slug },
      content: componentDefinitionContent(value),
    },
  ];
  const desiredViewFiles = new Set(Object.keys(value.views).map((target) => `${target}.yaml`));
  for (const existing of await existingViewFiles(context, value.slug)) {
    if (!desiredViewFiles.has(existing)) {
      changes.push({
        op: "delete",
        target: { kind: "SurfaceComponent", slug: value.slug, companion: `views/${existing}` },
      });
    }
  }
  for (const [target, view] of Object.entries(value.views)) {
    changes.push({
      op: "put",
      target: { kind: "SurfaceComponent", slug: value.slug, companion: `views/${target}.yaml` },
      content: stringify(view),
    });
  }
  return changes;
}

const create = defineApiTool<SurfaceComponentToolContext>({
  name: "surface_component_create",
  description:
    "Create a validated business Surface component under surface-components/<slug> and publish it atomically to the soul repo.",
  tier: "system",
  mutating: true,
  inputSchema: DEFINITION,
  authorization: {
    action: "soul.surface_component.create",
    resources: ["soul.surface_component"],
    targets: surfaceComponentTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, context) => {
    const invalid = validateComponent(args, context.surfaceSupport);
    if (invalid) return invalid;
    const value = args as ComponentValue;
    try {
      await context.soulWriter.apply({
        subject: `soul: add Surface component ${value.slug}`,
        source: "agent",
        actor: context.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
        businessId: DEPLOYMENT_BUSINESS_ID,
        changes: await buildComponentChanges(context, value),
        preconditions: [{ kind: "SurfaceComponent", slug: value.slug, state: "absent" }],
      });
      return ok({ name: `business.${value.slug}`, version: value.version });
    } catch (error) {
      if (error instanceof SoulWriteError) {
        return mapSurfaceWriteError(error, () =>
          err("validation_error", "Surface component already exists.")
        );
      }
      return soulCommitError(error, reason(error));
    }
  },
});

const update = defineApiTool<SurfaceComponentToolContext>({
  name: "surface_component_update",
  description:
    "Replace and revalidate an existing business Surface component, then publish it atomically to the soul repo.",
  tier: "system",
  mutating: true,
  inputSchema: DEFINITION,
  authorization: {
    action: "soul.surface_component.update",
    resources: ["soul.surface_component"],
    targets: surfaceComponentTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, context) => {
    const invalid = validateComponent(args, context.surfaceSupport);
    if (invalid) return invalid;
    const value = args as ComponentValue;
    try {
      await context.soulWriter.apply({
        subject: `soul: update Surface component ${value.slug}`,
        source: "agent",
        actor: context.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
        businessId: DEPLOYMENT_BUSINESS_ID,
        changes: await buildComponentChanges(context, value),
        preconditions: [{ kind: "SurfaceComponent", slug: value.slug, state: "present" }],
      });
      return ok({ name: `business.${value.slug}`, version: value.version });
    } catch (error) {
      if (error instanceof SoulWriteError) {
        return mapSurfaceWriteError(error, () =>
          err("not_found", "Surface component was not found.")
        );
      }
      return soulCommitError(error, reason(error));
    }
  },
});

const get = defineApiTool<SurfaceComponentToolContext>({
  name: "surface_component_get",
  description: "Read one published business Surface component and its declarative views.",
  tier: "system",
  mutating: false,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug"],
    properties: { slug: { type: "string", pattern: SLUG } },
  },
  authorization: {
    action: "soul.surface_component.read",
    resources: ["soul.surface_component"],
    targets: surfaceComponentTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, context) => {
    const { slug } = args as { slug: string };
    const componentDirectory = directory(context, slug);
    try {
      const component = parse(await readFile(join(componentDirectory, "component.yaml"), "utf8"));
      const viewFiles = await readdir(join(componentDirectory, "views"));
      const views = Object.fromEntries(
        await Promise.all(
          viewFiles
            .filter((file) => file.endsWith(".yaml"))
            .map(async (file) => [
              file.slice(0, -5),
              parse(await readFile(join(componentDirectory, "views", file), "utf8")),
            ])
        )
      );
      return ok({ slug, component, views });
    } catch {
      return err("not_found", "Surface component was not found.");
    }
  },
});

const list = defineApiTool<SurfaceComponentToolContext>({
  name: "surface_component_list",
  description: "List published business Surface components.",
  tier: "system",
  mutating: false,
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  authorization: {
    action: "soul.surface_component.list",
    resources: ["soul.surface_component"],
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (_args, context) => {
    try {
      const entries = await readdir(root(context), { withFileTypes: true });
      return ok({
        components: entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => `business.${entry.name}`)
          .sort(),
      });
    } catch {
      return ok({ components: [] });
    }
  },
});

export const SURFACE_COMPONENT_TOOLS: readonly ApiToolDefinition<SurfaceComponentToolContext>[] = [
  create,
  update,
  get,
  list,
];
