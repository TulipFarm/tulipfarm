import { canonicalHash } from "@tulipfarm/schema/canonicalize";
import { SHIPPED_SURFACE_COMPONENTS, surfaceComponentFor } from "./catalog";
import type {
  SurfaceComponentDefinition,
  SurfaceComponentSupport,
  SurfaceRendererManifest,
  SurfaceTarget,
} from "./contracts";
import { sameTarget, targetKey } from "./contracts";

export interface SurfaceCatalogExtension {
  readonly definition: SurfaceComponentDefinition;
  readonly targets: readonly SurfaceTarget[];
}

function jsonProjection(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Surface catalog metadata must be JSON-compatible.");
  }
  return JSON.parse(serialized) as unknown;
}

export class SurfaceRegistry implements SurfaceComponentSupport {
  readonly manifests: readonly SurfaceRendererManifest[];
  private readonly manifestsByTarget: ReadonlyMap<string, SurfaceRendererManifest>;

  constructor(manifests: readonly SurfaceRendererManifest[]) {
    const manifestsByTarget = new Map<string, SurfaceRendererManifest>();
    for (const manifest of manifests) {
      for (const target of manifest.targets) {
        const key = targetKey(target);
        if (manifestsByTarget.has(key)) {
          throw new Error(`Multiple Surface renderers are registered for ${key}.`);
        }
        manifestsByTarget.set(key, manifest);
      }
      for (const [name, versions] of Object.entries(manifest.components)) {
        for (const version of versions) {
          if (!surfaceComponentFor(name, version)) {
            throw new Error(
              `${manifest.renderer} advertises unknown Surface component ${name}@${version}.`
            );
          }
        }
      }
    }
    this.manifests = Object.freeze([...manifests]);
    this.manifestsByTarget = manifestsByTarget;
  }

  manifestFor(target: SurfaceTarget): SurfaceRendererManifest | undefined {
    return this.manifestsByTarget.get(targetKey(target));
  }

  supports(
    target: SurfaceTarget,
    component: { readonly name: string; readonly version: string }
  ): boolean {
    const manifest = this.manifestFor(target);
    return manifest?.components[component.name]?.includes(component.version) === true;
  }

  catalogFor(
    target: SurfaceTarget,
    extensions: readonly SurfaceCatalogExtension[] = []
  ): readonly SurfaceComponentDefinition[] {
    const manifest = this.manifestFor(target);
    if (!manifest) return [];
    const shipped = SHIPPED_SURFACE_COMPONENTS.filter((component) =>
      manifest.components[component.name]?.includes(component.version)
    );
    const additions = extensions
      .filter((extension) => extension.targets.some((supported) => sameTarget(supported, target)))
      .map((extension) => extension.definition);
    return Object.freeze([...shipped, ...additions]);
  }

  catalogRevision(
    target: SurfaceTarget,
    extensions: readonly SurfaceCatalogExtension[] = []
  ): string {
    const manifest = this.manifestFor(target);
    return canonicalHash({
      target,
      renderer: manifest?.renderer ?? null,
      components: this.catalogFor(target, extensions).map((component) => ({
        name: component.name,
        version: component.version,
        description: component.description,
        propsSchema: jsonProjection(component.propsSchema),
        events: component.events.map((event) => ({
          name: event.name,
          description: event.description,
          inputSchema: jsonProjection(event.inputSchema),
        })),
        examples: jsonProjection(component.examples),
      })),
    });
  }

  capabilitiesFor(target: SurfaceTarget): readonly string[] {
    return this.manifestFor(target)?.interactionCapabilities ?? [];
  }
}

export function createSurfaceRegistry(
  manifests: readonly SurfaceRendererManifest[]
): SurfaceRegistry {
  return new SurfaceRegistry(manifests);
}
