import type { SoulSurfaceComponent } from "@tulipfarm/surface";
import {
  createSurfaceRegistry,
  type PresentationContext,
  type SurfaceCatalogExtension,
  type SurfaceComponentDefinition,
  type SurfaceRendererManifest,
  type SurfaceTarget,
  validateSoulSurfaceComponent,
} from "@tulipfarm/surface";
import { githubCheckRunManifest, githubCommentManifest } from "@tulipfarm/surface-github/manifest";
import { slackMessageManifest, slackModalManifest } from "@tulipfarm/surface-slack/manifest";
import { telegramManifest } from "@tulipfarm/surface-telegram/manifest";
import { surfaceWebManifest } from "@tulipfarm/surface-web/manifest";

export const SURFACE_RENDERER_MANIFESTS: readonly SurfaceRendererManifest[] = Object.freeze([
  surfaceWebManifest,
  slackMessageManifest,
  slackModalManifest,
  telegramManifest,
  githubCommentManifest,
  githubCheckRunManifest,
]);

export const surfaceRendererRegistry = createSurfaceRegistry(SURFACE_RENDERER_MANIFESTS);

export function surfaceCatalogExtensions(
  components: readonly SoulSurfaceComponent[]
): readonly SurfaceCatalogExtension[] {
  return components.map((component) => ({
    definition: validateSoulSurfaceComponent(component, surfaceRendererRegistry),
    targets: component.targets,
  }));
}

export function surfaceCatalogFor(
  target: SurfaceTarget,
  components: readonly SoulSurfaceComponent[] = []
): readonly SurfaceComponentDefinition[] {
  return surfaceRendererRegistry.catalogFor(target, surfaceCatalogExtensions(components));
}

export function surfaceCatalogRevisionFor(
  target: SurfaceTarget,
  components: readonly SoulSurfaceComponent[] = []
): string {
  return surfaceRendererRegistry.catalogRevision(target, surfaceCatalogExtensions(components));
}

export function surfaceCatalogPromptFor(
  target: SurfaceTarget,
  components: readonly SoulSurfaceComponent[] = []
): string {
  return surfaceRendererRegistry.catalogPrompt(target, surfaceCatalogExtensions(components));
}

export function presentationContextFor(
  target: SurfaceTarget,
  destination: string
): PresentationContext {
  return {
    target,
    destination,
    rendererCapabilities: surfaceRendererRegistry.capabilitiesFor(target),
  };
}
