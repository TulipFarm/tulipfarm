import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TSchema } from "@sinclair/typebox";
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
  type SurfaceCodeView,
  type SurfaceComponentSupport,
  SurfaceStyleSchema,
  surfaceSchemaIssues,
  validateSoulSurfaceComponent,
} from "@tulipfarm/surface";
import { isSurfaceAction } from "@tulipfarm/surface/client";
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
import { compileSurfaceCodeView } from "./code-view";

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
    channel: { enum: ["web", "slack", "github"] },
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
    'Declarative trusted-component composition, e.g. {"component": {"name": "Status", "version": "1.0"}, ' +
    '"props": {"label": {"$prop": "/label"}, "tone": "positive"}}. ' +
    'component.name is either a shipped catalog name (e.g. "Status", "Chart") or another business.<slug> ' +
    "component; component.version is that component's version string. props holds the child component's own " +
    "props, each either a literal or a {$prop:'/pointer'} binding into this component's own propsSchema. " +
    "A node may also carry style: {tone?, radius?, size?} from the closed Surface token vocabulary, and " +
    "children: an array of further view nodes of this same shape.",
  required: ["component", "props"],
  properties: {
    component: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version"],
      properties: {
        name: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
      },
    },
    props: { type: "object" },
    style: SurfaceStyleSchema,
  },
};
const CODE = {
  type: "object",
  additionalProperties: false,
  description:
    "Authored view code for the web channel, used when no composition of shipped components can " +
    "express what was asked. Provide { web: { source } } — a single JSX source defining " +
    "function render(props, tulip) and returning JSX. It is compiled and validated here, so a " +
    "syntax error comes back as a tool error you can fix. Compute every coordinate, scale and tick " +
    "yourself and bake the numbers into props: the runtime performs no layout and no data " +
    "transformation. The code runs in an isolated frame with no network, no storage, no cookies and " +
    "no access to the page. Import nothing. To make it interactive, put the action in props as an " +
    'object — { event: "your.event" }, never a bare event-name string — and pass that same object ' +
    "to tulip.emit(action, input). Every example must carry it, because the handles authorising an " +
    "emit are minted from the published props, so an action absent there is silently dropped. Emit on " +
    "commit (blur, Enter, an explicit save), never per keystroke; hold in-progress edits in React " +
    "state. A code view renders on web only; declare a declarative view for any other target.",
  properties: {
    web: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: { source: { type: "string", minLength: 1 } },
    },
  },
};
const DEFINITION = {
  type: "object",
  additionalProperties: false,
  required: ["slug", "version", "description", "propsSchema", "events", "examples", "targets"],
  properties: {
    slug: { type: "string", pattern: SLUG },
    version: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    propsSchema: {
      type: "object",
      description:
        "JSON Schema for this component's props, and nothing else. Its own keywords are type, " +
        "required and properties. `examples`, `events`, `targets`, `views` and `code` are siblings " +
        "of propsSchema at the top level of this call — never keys inside it, even though " +
        "`examples` is also a JSON Schema keyword.",
    },
    events: {
      type: "array",
      description:
        "Every event the view can emit. Required: pass [] when the component is display-only.",
      items: EVENT,
    },
    examples: {
      type: "array",
      description:
        "Complete example prop objects, each valid against propsSchema. A top-level field, not the " +
        "JSON Schema `examples` keyword inside propsSchema.",
      minItems: 1,
    },
    targets: { type: "array", minItems: 1, items: TARGET },
    views: {
      type: "object",
      additionalProperties: false,
      properties: {
        default: VIEW,
        web: VIEW,
        slack: VIEW,
        github: VIEW,
      },
    },
    code: CODE,
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

/**
 * Whether authored code hands `tulip.emit` anything at all.
 *
 * Deliberately a text test, not analysis: the point is only to know whether this component claims
 * to be interactive, so a missed exotic call site costs the author nothing a working view needed.
 */
const EMITS_ACTION = /\btulip\s*\.\s*emit\s*\(/;

/**
 * Whether a value holds a well-formed action anywhere inside it.
 *
 * Mirrors how the renderer mints handles — it walks the published props for actions — so an
 * example that fails this test would publish a view whose every emit is dropped at the host.
 */
function containsSurfaceAction(value: unknown): boolean {
  if (isSurfaceAction(value)) return true;
  if (Array.isArray(value)) return value.some(containsSurfaceAction);
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some(containsSurfaceAction);
}

/**
 * Validate raw model output and, when it carries authored code, compile it.
 *
 * Returns either the tool error to report or the component to publish — the compiled form, since
 * only the API may produce it: an agent that could submit its own compiled output would make the
 * readable `code/*.source.jsx` in the Soul's history a claim rather than the truth.
 */
async function prepareComponent(
  value: unknown,
  surfaceSupport?: SurfaceComponentSupport
): Promise<{ error: ToolCallResult } | { component: ComponentValue }> {
  if (!validateDefinition(value)) {
    const issue = validateDefinition.errors?.[0];
    return {
      error: err(
        "validation_error",
        `${issue?.instancePath || "/"} ${issue?.message ?? "is invalid"}`
      ),
    };
  }
  const definition = value as {
    slug: string;
    propsSchema: Record<string, unknown>;
    examples: unknown[];
    targets: Array<{ channel: string; surface: string }>;
    views?: Record<string, unknown>;
    code?: Record<string, { source: string }>;
  };
  const invalid = (message: string) => ({ error: err("validation_error", message) });
  try {
    ajv.compile(definition.propsSchema);
  } catch (error) {
    return invalid(`Invalid propsSchema: ${reason(error)}`);
  }
  for (const [index, example] of definition.examples.entries()) {
    const issues = surfaceSchemaIssues(definition.propsSchema as TSchema, example);
    if (issues.length > 0) {
      return invalid(
        `Example ${index} does not match propsSchema at ${issues[0]?.path || "/"}: ${issues[0]?.message ?? "invalid"}.`
      );
    }
  }
  const views = definition.views ?? {};
  const targetChannels = new Set(definition.targets.map((target) => target.channel));
  for (const channel of Object.keys(views).filter((name) => name !== "default")) {
    if (!targetChannels.has(channel)) {
      return invalid(`View "${channel}" has no declared target.`);
    }
  }
  // Scoped to declarative views: authored code is JSX, so this test would reject every code view.
  const serialized = JSON.stringify(views);
  if (/(<\/?[a-z]|javascript:|<script|@import)/i.test(serialized)) {
    return invalid(
      "Views may contain only trusted component composition, literals, and property bindings."
    );
  }
  const code: Record<string, SurfaceCodeView> = {};
  for (const [channel, entry] of Object.entries(definition.code ?? {})) {
    const compiled = await compileSurfaceCodeView(channel, entry.source);
    if ("error" in compiled) return invalid(compiled.error);
    if (EMITS_ACTION.test(entry.source)) {
      const exampleWithoutAction = definition.examples.findIndex(
        (example) => !containsSurfaceAction(example)
      );
      if (exampleWithoutAction !== -1) {
        return invalid(
          `Code view "${channel}" calls tulip.emit, but example ${exampleWithoutAction} declares no ` +
            'action. Put the action in props as an object — { "event": "your.event" } — and pass ' +
            "that same object to tulip.emit. A bare event-name string mints no handle, so the emit " +
            "is dropped and the view looks inert."
        );
      }
    }
    code[channel] = compiled.view;
  }
  const component = {
    ...definition,
    views,
    ...(Object.keys(code).length > 0 ? { code } : {}),
  } as ComponentValue;
  try {
    validateSoulSurfaceComponent(
      { ...component, name: `business.${definition.slug}` } as unknown as SoulSurfaceComponent,
      surfaceSupport
    );
  } catch (error) {
    return invalid(reason(error));
  }
  return { component };
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
  code?: Record<string, SurfaceCodeView>;
};

const codeSourcePath = (channel: string) => `code/${channel}.source.jsx`;
const codeModulePath = (channel: string) => `code/${channel}.js`;

/**
 * The `code:` block is a pointer manifest, never inline text: the component's 256 KiB publication
 * limit and every catalog projection must stay proportional to its semantics, not to how long the
 * authored source happens to be.
 */
function codeManifest(value: ComponentValue) {
  const entries = Object.entries(value.code ?? {}).map(([channel, view]) => [
    channel,
    {
      source: codeSourcePath(channel),
      module: codeModulePath(channel),
      sourceSha256: view.sourceSha256,
    },
  ]);
  return entries.length > 0 ? { code: Object.fromEntries(entries) } : {};
}

function componentDefinitionContent(value: ComponentValue): string {
  return stringify({
    name: `business.${value.slug}`,
    version: value.version,
    description: value.description,
    propsSchema: value.propsSchema,
    events: value.events,
    examples: value.examples,
    targets: value.targets,
    ...codeManifest(value),
    metadata: { protocol: "tsp", protocolVersion: "1.0" },
  });
}

/** The files currently on disk in one of the component's companion directories. */
async function existingCompanionFiles(
  context: SurfaceComponentToolContext,
  slug: string,
  companion: "views" | "code"
): Promise<string[]> {
  try {
    return await readdir(join(directory(context, slug), companion));
  } catch {
    // A missing companion directory means there are no files to list.
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
  const desired = new Set<string>();
  for (const target of Object.keys(value.views)) desired.add(`views/${target}.yaml`);
  for (const channel of Object.keys(value.code ?? {})) {
    desired.add(codeSourcePath(channel));
    desired.add(codeModulePath(channel));
  }
  for (const companion of ["views", "code"] as const) {
    for (const existing of await existingCompanionFiles(context, value.slug, companion)) {
      const path = `${companion}/${existing}`;
      if (desired.has(path)) continue;
      changes.push({
        op: "delete",
        target: { kind: "SurfaceComponent", slug: value.slug, companion: path },
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
  for (const [channel, view] of Object.entries(value.code ?? {})) {
    changes.push({
      op: "put",
      target: { kind: "SurfaceComponent", slug: value.slug, companion: codeSourcePath(channel) },
      content: view.source,
    });
    changes.push({
      op: "put",
      target: { kind: "SurfaceComponent", slug: value.slug, companion: codeModulePath(channel) },
      content: view.compiled,
    });
  }
  return changes;
}

const create = defineApiTool<SurfaceComponentToolContext>({
  name: "surface_component_create",
  description:
    "Create a validated business Surface component under surface-components/<slug> and publish it atomically to the soul repo. " +
    "Use this when present's shipped catalog has no component, or no matching enum value on an existing component " +
    "(e.g. a chart kind), for what the user asked — compose one from shipped primitives via $prop bindings rather " +
    "than approximating the request with the nearest existing option. When no composition of shipped primitives can " +
    "draw it — an area chart, a spreadsheet grid, any shape the catalog never anticipated — pass code.web.source " +
    "instead: authored JSX that draws exactly what was asked for. Never fall back to the nearest shipped component. " +
    "Call surface_component_list first to reuse an " +
    "existing business component instead of duplicating it. This is a routine, low-risk write to the soul repo, not an " +
    "irreversible or sensitive action — call it directly as soon as the gap is identified, do not ask the user for " +
    "permission first and do not offer it as one of several options.",
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
    const prepared = await prepareComponent(args, context.surfaceSupport);
    if ("error" in prepared) return prepared.error;
    const value = prepared.component;
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
    const prepared = await prepareComponent(args, context.surfaceSupport);
    if ("error" in prepared) return prepared.error;
    const value = prepared.component;
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
      // `component.yaml` alone decides the component exists. A component whose only view is
      // authored code has no `views/` directory at all, and reading one that is not there used to
      // throw into the catch below and report a published component as missing.
      const viewFiles = await readdir(join(componentDirectory, "views")).catch(() => []);
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
