import { type TSchema, Type } from "@sinclair/typebox";
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

export interface SurfaceBinding {
  readonly $prop: string;
}

export interface SurfaceViewNode {
  readonly component: { readonly name: string; readonly version: string };
  readonly props: Readonly<Record<string, unknown | SurfaceBinding>>;
  readonly children?: readonly SurfaceViewNode[];
}

export interface ResolvedSurfaceViewNode {
  readonly component: { readonly name: string; readonly version: string };
  readonly props: Readonly<Record<string, unknown>>;
  readonly children?: readonly ResolvedSurfaceViewNode[];
}

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
  support?: SurfaceComponentSupport
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
  }
  node.children?.forEach((child, index) => {
    assertView(child, `${path}/children/${index}`, depth + 1, count, component, targets, support);
  });
}

export function validateSoulSurfaceComponent(
  component: SoulSurfaceComponent,
  support?: SurfaceComponentSupport
): SurfaceComponentDefinition {
  if (!/^[a-z][a-z0-9-]*$/.test(component.slug)) throw new Error("Invalid component slug");
  if (component.name !== `business.${component.slug}`) {
    throw new Error(`Business component name must be business.${component.slug}`);
  }
  if (JSON.stringify(component).length > 256_000) {
    throw new Error("Business component exceeds the 256 KiB publication limit");
  }
  for (const target of component.targets) {
    if (!Value.Check(SurfaceTargetSchema, target)) throw new Error("Invalid Surface target");
    if (!component.views[target.channel] && !component.views.default) {
      throw new Error(`Missing view for ${target.channel}/${target.surface}`);
    }
  }
  for (const [target, view] of Object.entries(component.views)) {
    if (!view) continue;
    const viewTargets =
      target === "default"
        ? component.targets
        : component.targets.filter((candidate) => candidate.channel === target);
    if (target !== "default" && viewTargets.length === 0) {
      throw new Error(`View "${target}" does not support a declared target`);
    }
    assertView(view, `/views/${target}`, 1, { value: 0 }, component, viewTargets, support);
  }
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
    return {
      component: node.component,
      props: resolvedProps,
      ...(children && children.length > 0 ? { children } : {}),
    };
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
  const view = nested.views[target.channel] ?? nested.views.default;
  if (!view) throw new Error(`${key}: missing ${target.channel}/${target.surface} view`);
  if (node.children && node.children.length > 0) {
    throw new Error(`${key}: composed business components cannot declare additional children`);
  }
  return resolveViewNode(view, resolvedProps, target, components, [...stack, key], support);
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
