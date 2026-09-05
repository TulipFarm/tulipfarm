import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { surfaceComponentFor } from "./catalog";
import type {
  SurfaceComponentDefinition,
  SurfaceComponentSupport,
  SurfaceEventDefinition,
  SurfaceTarget,
} from "./contracts";
import { SurfaceTargetSchema, sameTarget } from "./contracts";
import { surfaceSchemaIssues } from "./schema";
import { SurfaceStyleSchema } from "./tokens";

export interface SurfaceBinding {
  readonly $prop: string;
}

export interface SurfaceViewNode {
  readonly component: { readonly name: string; readonly version: string };
  readonly props: Readonly<Record<string, unknown | SurfaceBinding>>;
  readonly style?: Readonly<Static<typeof SurfaceStyleSchema>>;
  readonly children?: readonly SurfaceViewNode[];
}

export interface ResolvedSurfaceViewNode {
  readonly component: { readonly name: string; readonly version: string };
  readonly props: Readonly<Record<string, unknown>>;
  readonly style?: Readonly<Static<typeof SurfaceStyleSchema>>;
  readonly children?: readonly ResolvedSurfaceViewNode[];
}

/**
 * A view whose markup is authored code rather than a composition of shipped components, executed in
 * a sandboxed browser frame. The isolation boundary is that frame's opaque origin and CSP, never
 * inspection of `source` — see docs/architecture/adr-011-sandboxed-surface-code.md.
 *
 * Both texts live in the component's `code/` companion directory, not inline, so the 256 KiB
 * publication cap and every catalog projection stay proportional to the component's semantics.
 */
export interface SurfaceCodeView {
  readonly source: string;
  readonly compiled: string;
  readonly sourceSha256: string;
}

/** Only the web renderer can execute a frame; Slack and GitHub would render nothing. */
export const SURFACE_CODE_VIEW_CHANNELS = ["web"] as const;

export type SurfaceCodeViewChannel = (typeof SURFACE_CODE_VIEW_CHANNELS)[number];

/** Authored source cap, well under the 256 KiB whole-component publication limit. */
export const SURFACE_CODE_VIEW_MAX_SOURCE_BYTES = 64 * 1024;

export const SURFACE_CODE_VIEW_MAX_COMPILED_BYTES = 128 * 1024;

export interface SoulSurfaceComponent {
  readonly slug: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly propsSchema: TSchema;
  readonly events: readonly SurfaceEventDefinition[];
  readonly examples: readonly unknown[];
  readonly targets: readonly SurfaceTarget[];
  readonly views: Readonly<Partial<Record<SurfaceTarget["channel"] | "default", SurfaceViewNode>>>;
  readonly code?: Readonly<Partial<Record<SurfaceCodeViewChannel, SurfaceCodeView>>>;
}

/** The code view a component renders on `target`, or undefined when it composes shipped components. */
export function soulSurfaceCodeViewFor(
  component: SoulSurfaceComponent,
  target: SurfaceTarget
): SurfaceCodeView | undefined {
  return (component.code as Record<string, SurfaceCodeView | undefined> | undefined)?.[
    target.channel
  ];
}

const bindingSchema = Type.Object(
  { $prop: Type.String({ pattern: "^(/(?:[^/~]|~0|~1)*)*$" }) },
  { additionalProperties: false }
);

export function isSurfaceBinding(value: unknown): value is SurfaceBinding {
  return Value.Check(bindingSchema, value);
}

function assertView(
  node: SurfaceViewNode,
  path: string,
  depth: number,
  count: { value: number },
  component: SoulSurfaceComponent,
  targets: readonly SurfaceTarget[],
  support: SurfaceComponentSupport | undefined,
  /** Top-level prop names some binding in this component's views actually reads. */
  bound: Set<string>
) {
  count.value += 1;
  if (depth > 10) throw new Error(`${path}: view composition exceeds ten levels`);
  if (count.value > 500) throw new Error(`${path}: view composition exceeds 500 nodes`);
  if (
    typeof node !== "object" ||
    node === null ||
    typeof node.component !== "object" ||
    node.component === null ||
    !node.component.name ||
    !node.component.version ||
    typeof node.props !== "object" ||
    node.props === null
  ) {
    throw new Error(`${path}: component name and version are required`);
  }
  if (node.component.name === component.name) {
    throw new Error(`${path}: component composition contains a direct cycle`);
  }
  if (node.style !== undefined) {
    const styleIssues = surfaceSchemaIssues(SurfaceStyleSchema, node.style);
    if (styleIssues.length > 0) {
      throw new Error(`${path}/style: invalid style at ${styleIssues[0]?.path || "/"}`);
    }
  }
  const shipped = surfaceComponentFor(node.component.name, node.component.version);
  if (!shipped && !node.component.name.startsWith("business.")) {
    throw new Error(`${path}: unknown component ${node.component.name}@${node.component.version}`);
  }
  if (shipped && support) {
    for (const target of targets) {
      if (!support.supports(target, shipped)) {
        throw new Error(
          `${path}: ${node.component.name}@${node.component.version} does not support ${target.channel}/${target.surface}`
        );
      }
    }
  }
  const topLevelProps =
    typeof component.propsSchema.properties === "object" &&
    component.propsSchema.properties !== null
      ? component.propsSchema.properties
      : {};
  for (const [key, value] of Object.entries(node.props)) {
    if (isSurfaceBinding(value) && !value.$prop.startsWith("/")) {
      throw new Error(`${path}/props/${key}: binding must be a JSON pointer`);
    }
    const topLevel = isSurfaceBinding(value) ? value.$prop.split("/")[1] : undefined;
    if (topLevel && !(topLevel in topLevelProps)) {
      throw new Error(`${path}/props/${key}: binding references unknown prop "${topLevel}"`);
    }
    if (topLevel) bound.add(topLevel);
  }
  node.children?.forEach((child, index) => {
    assertView(
      child,
      `${path}/children/${index}`,
      depth + 1,
      count,
      component,
      targets,
      support,
      bound
    );
  });
}

/**
 * Refuses a declared prop that no view binds.
 *
 * Binding validation ran one way only — every `$prop` had to name a declared prop, but a declared
 * prop needed no reader. That let a component advertise capability it does not have: a published
 * `business.area-chart` declared `fillColor`, described it as the fill under the line, bound only
 * `labels` and `series`, and resolved to the shipped `Chart` in `line` mode. Both the propsSchema
 * and the description were true of nothing, and every later Turn reused it as if they were.
 *
 * A component carrying a code view is exempt: authored code receives the whole props object, so
 * there is no binding to look for.
 */
function assertEveryPropIsRead(component: SoulSurfaceComponent, bound: ReadonlySet<string>): void {
  if (Object.values(component.code ?? {}).some((view) => view !== undefined)) return;
  const declared =
    typeof component.propsSchema.properties === "object" &&
    component.propsSchema.properties !== null
      ? Object.keys(component.propsSchema.properties)
      : [];
  const unread = declared.filter((prop) => !bound.has(prop));
  if (unread.length === 0) return;
  throw new Error(
    `propsSchema declares ${unread.map((prop) => `"${prop}"`).join(", ")}, which no view reads. ` +
      "A prop no view binds is silently discarded, so the component promises something it cannot " +
      "draw: bind it with $prop, or drop it from propsSchema and author a code view if the shipped " +
      "components cannot express it."
  );
}

const utf8 = new TextEncoder();

function byteLength(value: string): number {
  return utf8.encode(value).length;
}

function assertCodeView(view: SurfaceCodeView, channel: string, component: SoulSurfaceComponent) {
  const path = `/code/${channel}`;
  if (!(SURFACE_CODE_VIEW_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`${path}: a code view supports the web channel only`);
  }
  if (!component.targets.some((target) => target.channel === channel)) {
    throw new Error(`${path}: code view does not support a declared target`);
  }
  if (typeof view.source !== "string" || view.source.length === 0) {
    throw new Error(`${path}: code view requires authored source`);
  }
  if (typeof view.compiled !== "string" || view.compiled.length === 0) {
    throw new Error(`${path}: code view requires compiled output`);
  }
  if (byteLength(view.source) > SURFACE_CODE_VIEW_MAX_SOURCE_BYTES) {
    throw new Error(
      `${path}: code view source exceeds ${SURFACE_CODE_VIEW_MAX_SOURCE_BYTES} bytes`
    );
  }
  if (byteLength(view.compiled) > SURFACE_CODE_VIEW_MAX_COMPILED_BYTES) {
    throw new Error(
      `${path}: compiled code view exceeds ${SURFACE_CODE_VIEW_MAX_COMPILED_BYTES} bytes`
    );
  }
}

export function validateSoulSurfaceComponent(
  component: SoulSurfaceComponent,
  support?: SurfaceComponentSupport
): SurfaceComponentDefinition {
  if (!/^[a-z][a-z0-9-]*$/.test(component.slug)) throw new Error("Invalid component slug");
  if (component.name !== `business.${component.slug}`) {
    throw new Error(`Business component name must be business.${component.slug}`);
  }
  // Code companions carry their own byte caps; counting them here would make this limit — which
  // exists to bound the component's *semantics* — a function of how long the authored source is.
  const { code, ...semantics } = component;
  if (JSON.stringify(semantics).length > 256_000) {
    throw new Error("Business component exceeds the 256 KiB publication limit");
  }
  for (const target of component.targets) {
    if (!Value.Check(SurfaceTargetSchema, target)) throw new Error("Invalid Surface target");
    if (
      !component.views[target.channel] &&
      !component.views.default &&
      !soulSurfaceCodeViewFor(component, target)
    ) {
      throw new Error(`Missing view for ${target.channel}/${target.surface}`);
    }
  }
  for (const [channel, view] of Object.entries(code ?? {})) {
    if (view) assertCodeView(view, channel, component);
  }
  const bound = new Set<string>();
  let declarativeViews = 0;
  for (const [target, view] of Object.entries(component.views)) {
    if (!view) continue;
    declarativeViews += 1;
    const viewTargets =
      target === "default"
        ? component.targets
        : component.targets.filter((candidate) => candidate.channel === target);
    if (target !== "default" && viewTargets.length === 0) {
      throw new Error(`View "${target}" does not support a declared target`);
    }
    assertView(view, `/views/${target}`, 1, { value: 0 }, component, viewTargets, support, bound);
  }
  if (declarativeViews > 0) assertEveryPropIsRead(component, bound);
  for (const [index, example] of component.examples.entries()) {
    const issues = surfaceSchemaIssues(component.propsSchema, example);
    if (issues.length > 0) {
      throw new Error(
        `Invalid ${component.name}@${component.version} example ${index} at ${issues[0]?.path || "/"}`
      );
    }
  }
  return Object.freeze({
    name: component.name,
    version: component.version,
    description: component.description,
    propsSchema: component.propsSchema,
    events: component.events,
    examples: component.examples,
  });
}

function pointer(value: unknown, path: string): unknown {
  if (path === "") return value;
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((current, part) => {
      if (typeof current !== "object" || current === null) return undefined;
      return (current as Record<string, unknown>)[part];
    }, value);
}

export function resolveSurfaceBindings(
  value: unknown,
  props: Readonly<Record<string, unknown>>
): unknown {
  if (isSurfaceBinding(value)) return pointer(props, value.$prop);
  if (Array.isArray(value)) return value.map((entry) => resolveSurfaceBindings(entry, props));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveSurfaceBindings(entry, props)])
    );
  }
  return value;
}

function assertRecord(value: unknown, message: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Readonly<Record<string, unknown>>;
}

/** Overrides `resolved`'s style with `style` when the composing node declared one. */
function withStyle(
  resolved: ResolvedSurfaceViewNode,
  style: SurfaceViewNode["style"]
): ResolvedSurfaceViewNode {
  return style !== undefined ? { ...resolved, style } : resolved;
}

function resolveViewNode(
  node: SurfaceViewNode,
  props: Readonly<Record<string, unknown>>,
  target: SurfaceTarget,
  components: ReadonlyMap<string, SoulSurfaceComponent>,
  stack: readonly string[],
  support?: SurfaceComponentSupport
): ResolvedSurfaceViewNode {
  const resolvedProps = assertRecord(
    resolveSurfaceBindings(node.props, props),
    `${node.component.name}@${node.component.version}: resolved props must be an object`
  );
  const shipped = surfaceComponentFor(node.component.name, node.component.version);
  if (shipped) {
    if (support && !support.supports(target, shipped)) {
      throw new Error(
        `${node.component.name}@${node.component.version} does not support ${target.channel}/${target.surface}`
      );
    }
    const issues = surfaceSchemaIssues(shipped.propsSchema, resolvedProps);
    if (issues.length > 0) {
      const issue = issues[0];
      throw new Error(
        `${node.component.name}@${node.component.version}: invalid resolved props at ${issue?.path || "/"}`
      );
    }
    const children = node.children?.map((child) =>
      resolveViewNode(child, props, target, components, stack, support)
    );
    return withStyle(
      {
        component: node.component,
        props: resolvedProps,
        ...(children && children.length > 0 ? { children } : {}),
      },
      node.style
    );
  }

  const key = `${node.component.name}@${node.component.version}`;
  const nested = components.get(key);
  if (!nested) throw new Error(`Unknown business component ${key}`);
  if (stack.includes(key)) {
    throw new Error(`Surface component cycle: ${[...stack, key].join(" -> ")}`);
  }
  if (!nested.targets.some((supported) => sameTarget(supported, target))) {
    throw new Error(`${key} does not support ${target.channel}/${target.surface}`);
  }
  const nestedIssues = surfaceSchemaIssues(nested.propsSchema, resolvedProps);
  if (nestedIssues.length > 0) {
    const issue = nestedIssues[0];
    throw new Error(`${key}: invalid resolved props at ${issue?.path || "/"}`);
  }
  if (soulSurfaceCodeViewFor(nested, target)) {
    throw new Error(`${key}: a code-backed component cannot be composed into another component`);
  }
  const view = nested.views[target.channel] ?? nested.views.default;
  if (!view) throw new Error(`${key}: missing ${target.channel}/${target.surface} view`);
  if (node.children && node.children.length > 0) {
    throw new Error(`${key}: composed business components cannot declare additional children`);
  }
  const resolved = resolveViewNode(
    view,
    resolvedProps,
    target,
    components,
    [...stack, key],
    support
  );
  return withStyle(resolved, node.style);
}

export function resolveSoulSurfaceView(
  component: SoulSurfaceComponent,
  target: SurfaceTarget,
  props: Readonly<Record<string, unknown>>,
  catalog: readonly SoulSurfaceComponent[] = [component],
  support?: SurfaceComponentSupport
): ResolvedSurfaceViewNode {
  validateSoulSurfaceComponent(component, support);
  if (!component.targets.some((supported) => sameTarget(supported, target))) {
    throw new Error(
      `${component.name}@${component.version} does not support ${target.channel}/${target.surface}`
    );
  }
  const issues = surfaceSchemaIssues(component.propsSchema, props);
  if (issues.length > 0) {
    const issue = issues[0];
    throw new Error(
      `${component.name}@${component.version}: invalid props at ${issue?.path || "/"}`
    );
  }
  if (soulSurfaceCodeViewFor(component, target)) {
    throw new Error(
      `${component.name}@${component.version}: a code view renders in a sandbox, not a resolved tree`
    );
  }
  const view = component.views[target.channel] ?? component.views.default;
  if (!view) {
    throw new Error(
      `${component.name}@${component.version}: missing ${target.channel}/${target.surface} view`
    );
  }
  const components = new Map(
    catalog.map((candidate) => [`${candidate.name}@${candidate.version}`, candidate])
  );
  const root = `${component.name}@${component.version}`;
  return resolveViewNode(view, props, target, components, [root], support);
}

/** What the client needs to render a business component: a resolved tree, or a module to sandbox. */
export type SoulSurfacePresentation =
  | { readonly resolvedView: ResolvedSurfaceViewNode; readonly codeView?: undefined }
  | { readonly resolvedView?: undefined; readonly codeView: { readonly compiled: string } };

/**
 * Decide how one artifact of a business component reaches the client.
 *
 * A code view is deliberately not flattened: it has no tree, and resolving it server-side is what
 * confined authored components to re-compositions of the shipped catalog in the first place.
 */
export function resolveSoulSurfacePresentation(
  component: SoulSurfaceComponent,
  target: SurfaceTarget,
  props: Readonly<Record<string, unknown>>,
  catalog: readonly SoulSurfaceComponent[] = [component],
  support?: SurfaceComponentSupport
): SoulSurfacePresentation {
  const code = soulSurfaceCodeViewFor(component, target);
  if (code) {
    validateSoulSurfaceComponent(component, support);
    const issues = surfaceSchemaIssues(component.propsSchema, props);
    if (issues.length > 0) {
      throw new Error(
        `${component.name}@${component.version}: invalid props at ${issues[0]?.path || "/"}`
      );
    }
    return { codeView: { compiled: code.compiled } };
  }
  return { resolvedView: resolveSoulSurfaceView(component, target, props, catalog, support) };
}

export function validateSoulSurfaceCatalog(
  catalog: readonly SoulSurfaceComponent[],
  support?: SurfaceComponentSupport
): readonly SurfaceComponentDefinition[] {
  const keys = new Set<string>();
  const definitions = catalog.map((component) => {
    const key = `${component.name}@${component.version}`;
    if (keys.has(key)) throw new Error(`Duplicate Surface component ${key}`);
    keys.add(key);
    return validateSoulSurfaceComponent(component, support);
  });
  for (const component of catalog) {
    for (const target of component.targets) {
      // A code view has no tree to resolve; its props were already checked against propsSchema.
      if (soulSurfaceCodeViewFor(component, target)) continue;
      for (const [index, example] of component.examples.entries()) {
        resolveSoulSurfaceView(
          component,
          target,
          assertRecord(
            example,
            `${component.name}@${component.version}: example ${index} must be an object`
          ),
          catalog,
          support
        );
      }
    }
  }
  return definitions;
}
