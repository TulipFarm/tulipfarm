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
import type { SurfacePresentationPort } from "@tulipfarm/tool-host";

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

/**
 * The renderer registry projected onto the Tool host's port. A process without this port cannot
 * present anything, which is exactly what the durable runtime's Tool host reports.
 */
export const apiSurfacePresentation: SurfacePresentationPort = {
  contextFor: presentationContextFor,
  catalogFor: surfaceCatalogFor,
  catalogRevisionFor: surfaceCatalogRevisionFor,
  manifestFor: (target) => surfaceRendererRegistry.manifestFor(target),
};
