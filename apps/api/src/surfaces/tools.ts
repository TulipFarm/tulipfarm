import { randomUUID } from "node:crypto";
import { type TSchema, Type } from "@sinclair/typebox";
import {
  createSurfaceArtifact,
  type PresentationContext,
  resolveSoulSurfaceView,
  type SurfaceArtifact,
  type SurfaceComponentDefinition,
  SurfaceValidationError,
  surfaceActionKey,
  surfaceActionsForArtifact,
  targetKey,
} from "@tulipfarm/surface";
import type { RequestContext, ToolDef } from "@tulipfarm/tool-host";
import { defineApiTool, err, ok, toToolDef } from "@tulipfarm/tool-host";
import { surfaceRendererRegistry } from "./renderer-registry";

async function createActionHandles(
  artifact: SurfaceArtifact,
  inputSchema: TSchema,
  ctx: Parameters<ToolDef["execute"]>[1]
): Promise<Readonly<Record<string, string>>> {
  const actions = surfaceActionsForArtifact(artifact).filter((action) => !action.disabled);
  if (actions.length === 0) return {};
  if (!ctx.surfaceActionStore || !ctx.presentationContext) {
    throw new Error("The Surface action ledger is unavailable.");
  }
  const unique = new Map(actions.map((action) => [surfaceActionKey(action), action]));
  const entries = await Promise.all(
    [...unique.entries()].map(async ([key, action]) => {
      const stored = await ctx.surfaceActionStore?.create({
        artifactId: artifact.id,
        revision: artifact.revision,
        action,
        inputSchema,
        audience: artifact.audience,
        target: artifact.target,
        destination: ctx.presentationContext?.destination ?? "",
        conversationId: ctx.conversationId ?? null,
        runId: ctx.runId ?? null,
        waitId: null,
        guardrailRevision: ctx.guardrailRevision ?? "none",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      });
      if (!stored) throw new Error("The Surface action ledger is unavailable.");
      return [key, stored.handle] as const;
    })
  );
  return Object.fromEntries(entries);
}

function resolvedView(artifact: SurfaceArtifact, ctx: Parameters<ToolDef["execute"]>[1]) {
  if (!artifact.component.name.startsWith("business.")) return undefined;
  const component = ctx.surfaceComponents?.find(
    (candidate) =>
      candidate.name === artifact.component.name && candidate.version === artifact.component.version
  );
  if (!component) throw new Error("Published Surface component is unavailable.");
  return resolveSoulSurfaceView(
    component,
    artifact.target,
    artifact.props,
    ctx.surfaceComponents,
    surfaceRendererRegistry
  );
}

const componentSchema = (
  presentation: PresentationContext | undefined,
  components: readonly SurfaceComponentDefinition[] = []
): Record<string, unknown> => {
  if (!presentation) return { not: {} };
  return {
    type: "object",
    description:
      "A discriminated Surface component. Keep name and version separate and put all display data inside props.",
    oneOf: components.map((component) => ({
      type: "object",
      additionalProperties: false,
      required: ["name", "version", "props"],
      description: `${component.name} version ${component.version}`,
      properties: {
        name: {
          const: component.name,
          description: `Use exactly "${component.name}". Never append the version to this value.`,
        },
        version: {
          const: component.version,
          description: `Use exactly "${component.version}" as a separate field.`,
        },
        props: {
          ...component.propsSchema,
          description: `Props for ${component.name}; do not place these fields beside name or version.`,
        },
      },
      examples: component.examples.slice(0, 1).map((props) => ({
        name: component.name,
        version: component.version,
        props,
      })),
    })),
  };
};

const INPUT_COMPONENT_NAMES = new Set(["Choices", "Form"]);

function surfaceArtifactTarget(args: unknown) {
  const artifactId =
    typeof args === "object" && args !== null && "artifactId" in args ? args.artifactId : undefined;
  return typeof artifactId === "string" && artifactId.length > 0
    ? [{ type: "platform.surface", id: `artifact:${artifactId}` }]
    : [];
}

function awaitedSchemaFor(component: {
  readonly name: string;
  readonly props: Readonly<Record<string, unknown>>;
}): TSchema {
  if (component.name === "Choices") {
    const choices = Array.isArray(component.props.choices) ? component.props.choices : [];
    const values = choices.flatMap((choice) => {
      if (
        typeof choice !== "object" ||
        choice === null ||
        !("value" in choice) ||
        typeof choice.value !== "string"
      ) {
        return [];
      }
      return [choice.value];
    });
    return Type.Object(
      {
        value:
          values.length > 0
            ? Type.Union(values.map((value) => Type.Literal(value)))
            : Type.String({ minLength: 1 }),
      },
      { additionalProperties: false }
    );
  }

  if (component.name === "Form") {
    const fields = Array.isArray(component.props.fields) ? component.props.fields : [];
    const properties: Record<string, TSchema> = {};
    for (const field of fields) {
      if (
        typeof field !== "object" ||
        field === null ||
        !("name" in field) ||
        typeof field.name !== "string" ||
        !("input" in field) ||
        typeof field.input !== "string"
      ) {
        continue;
      }
      const schema =
        field.input === "number"
          ? Type.Number()
          : field.input === "checkbox"
            ? Type.Boolean()
            : Type.String();
      properties[field.name] = field.required === true ? schema : Type.Optional(schema);
    }
    return Type.Object(properties, { additionalProperties: false });
  }

  return Type.Record(Type.String(), Type.Unknown());
}

const PRESENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["component"],
  properties: {
    artifactId: { type: "string", minLength: 1 },
    component: {
      type: "object",
      description:
        'Use {"name":"ComponentName","version":"1.0","props":{...}}. Keep the version out of name.',
    },
    classification: {
      enum: ["public", "internal", "confidential", "restricted"],
    },
  },
};

const presentToolDefinition = defineApiTool<RequestContext>({
  name: "present",
  tier: "platform",
  mutating: false,
  description:
    "Create one non-blocking informational TSP Artifact. Do not use this Tool for Choices, Forms, or any response that must wait for the user; use request_input instead. Pass component as separate name, version, and props fields; never combine name and version.",
  inputSchema: PRESENT_SCHEMA,
  inputSchemaFor: (ctx) => ({
    ...PRESENT_SCHEMA,
    properties: {
      ...(PRESENT_SCHEMA.properties as Record<string, unknown>),
      component: componentSchema(
        ctx.presentationContext,
        (ctx.surfaceCatalog ?? []).filter((component) => !INPUT_COMPONENT_NAMES.has(component.name))
      ),
    },
  }),
  authorization: {
    action: "surface.present",
    resources: ["platform.surface"],
    targets: surfaceArtifactTarget,
    dataClasses: ["operational"],
  },
  availableTo: { requiresPresentation: true },
  handler: async (args, ctx) => {
    if (!ctx.presentationContext || !ctx.surfaceStore) {
      return err("presentation_unavailable", "This Turn has no presentation target.");
    }
    const value = args as {
      artifactId?: string;
      component: {
        name: string;
        version: string;
        props: Readonly<Record<string, unknown>>;
      };
      classification?: SurfaceArtifact["classification"];
    };
    try {
      const artifact = createSurfaceArtifact({
        id: value.artifactId ?? randomUUID(),
        component: { name: value.component.name, version: value.component.version },
        props: value.component.props,
        target: ctx.presentationContext.target,
        audience: [ctx.userId],
        classification: value.classification ?? "internal",
        catalog: ctx.surfaceCatalog,
        catalogRevision: ctx.surfaceCatalogRevision,
        rendererManifest: ctx.surfaceRendererManifest,
      });
      await ctx.surfaceStore.create(artifact, {
        runId: ctx.runId,
        stateKey: ctx.conversationId,
      });
      const actionHandles = await createActionHandles(
        artifact,
        ((args as { awaitedSchema?: TSchema }).awaitedSchema ??
          Type.Record(Type.String(), Type.Unknown())) as TSchema,
        ctx
      );
      ctx.events?.emit("surface.rendered", {
        target: targetKey(artifact.target),
        component: artifact.component.name,
        version: artifact.component.version,
        validation: "ok",
        render: "ok",
        validationPaths: [],
      });
      return ok({ artifact, actionHandles, resolvedView: resolvedView(artifact, ctx) });
    } catch (error) {
      if (error instanceof SurfaceValidationError) {
        return err("surface_invalid", error.message);
      }
      throw error;
    }
  },
});

export const presentTool: ToolDef = toToolDef(presentToolDefinition, (ctx) => ctx);

const UPDATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["artifactId", "expectedRevision", "props"],
  properties: {
    artifactId: { type: "string", minLength: 1 },
    expectedRevision: { type: "integer", minimum: 1 },
    props: { type: "object" },
  },
};

const updatePresentationToolDefinition = defineApiTool<RequestContext>({
  name: "update_presentation",
  tier: "platform",
  mutating: false,
  description:
    "Replace a Surface Artifact's validated props using optimistic revision concurrency.",
  inputSchema: UPDATE_SCHEMA,
  authorization: {
    action: "surface.update",
    resources: ["platform.surface"],
    targets: surfaceArtifactTarget,
    dataClasses: ["operational"],
  },
  availableTo: { requiresPresentation: true },
  handler: async (args, ctx) => {
    if (!ctx.presentationContext || !ctx.surfaceStore) {
      return err("presentation_unavailable", "This Turn has no presentation target.");
    }
    const value = args as {
      artifactId: string;
      expectedRevision: number;
      props: Readonly<Record<string, unknown>>;
    };
    try {
      const previous = await ctx.surfaceStore.get(value.artifactId);
      if (!previous?.audience.includes(ctx.userId)) {
        return err("not_found", "Surface Artifact was not found.");
      }
      if (
        previous.target.channel !== ctx.presentationContext.target.channel ||
        previous.target.surface !== ctx.presentationContext.target.surface
      ) {
        return err("surface_invalid", "The Artifact target does not match this Turn.");
      }
      const artifact = await ctx.surfaceStore.update(
        value.artifactId,
        value.expectedRevision,
        value.props,
        ctx.surfaceCatalog,
        ctx.surfaceRendererManifest,
        { runId: ctx.runId, stateKey: value.artifactId }
      );
      const actionHandles = await createActionHandles(
        artifact,
        Type.Record(Type.String(), Type.Unknown()),
        ctx
      );
      return ok({ artifact, actionHandles, resolvedView: resolvedView(artifact, ctx) });
    } catch (error) {
      return err(
        "surface_invalid",
        error instanceof Error ? error.message : "Surface Artifact update failed."
      );
    }
  },
});

export const updatePresentationTool: ToolDef = toToolDef(
  updatePresentationToolDefinition,
  (ctx) => ctx
);

const requestInputToolDefinition = defineApiTool<RequestContext>({
  name: "request_input",
  tier: "platform",
  // It makes no external change, but it is a control-flow barrier for the Tool loop.
  mutating: true,
  description:
    "Ask the user for a choice or typed response. This is the only Tool to use when the response must wait for user input; it presents the interactive component and pauses agent work until the response starts a later Chat Turn.",
  inputSchema: {
    ...PRESENT_SCHEMA,
  },
  inputSchemaFor: (ctx) => {
    const interactive = ctx.presentationContext
      ? (ctx.surfaceCatalog ?? []).filter(
          (component) =>
            component.events.length > 0 || ["Actions", "Choices", "Form"].includes(component.name)
        )
      : [];
    return {
      type: "object",
      additionalProperties: false,
      required: ["component"],
      properties: {
        artifactId: { type: "string", minLength: 1 },
        component: componentSchema(ctx.presentationContext, interactive),
        classification: {
          enum: ["public", "internal", "confidential", "restricted"],
        },
      },
    };
  },
  authorization: {
    action: "surface.request_input",
    resources: ["platform.surface"],
    targets: surfaceArtifactTarget,
    dataClasses: ["operational"],
  },
  availableTo: { requiresPresentation: true },
  handler: async (args, ctx) => {
    const value = args as {
      artifactId?: string;
      component: {
        name: string;
        version: string;
        props: Readonly<Record<string, unknown>>;
      };
      classification?: SurfaceArtifact["classification"];
    };
    const awaitedSchema = awaitedSchemaFor(value.component);
    const presented = await presentTool.execute({ ...value, awaitedSchema }, ctx);
    if (!presented.success) return presented;
    return ok({
      ...(presented.data as Record<string, unknown>),
      awaitedSchema,
      suspendRun: true,
    });
  },
});

export const requestInputTool: ToolDef = toToolDef(requestInputToolDefinition, (ctx) => ctx);

export const SURFACE_TOOLS: ToolDef[] = [presentTool, updatePresentationTool, requestInputTool];
