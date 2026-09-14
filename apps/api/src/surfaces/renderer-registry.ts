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
import { discordMessageManifest } from "@tulipfarm/surface-discord/manifest";
import { githubCheckRunManifest, githubCommentManifest } from "@tulipfarm/surface-github/manifest";
import { googleChatMessageManifest } from "@tulipfarm/surface-google-chat/manifest";
import {
  slackHomeManifest,
  slackMessageManifest,
  slackModalManifest,
} from "@tulipfarm/surface-slack/manifest";
import { teamsMessageManifest } from "@tulipfarm/surface-teams/manifest";
import { telegramMessageManifest } from "@tulipfarm/surface-telegram/manifest";
import { surfaceWebManifest } from "@tulipfarm/surface-web/manifest";
import type { SurfacePresentationPort } from "@tulipfarm/tool-host";

export const SURFACE_RENDERER_MANIFESTS: readonly SurfaceRendererManifest[] = Object.freeze([
  surfaceWebManifest,
  slackMessageManifest,
  slackModalManifest,
  slackHomeManifest,
  githubCommentManifest,
  githubCheckRunManifest,
  discordMessageManifest,
  teamsMessageManifest,
  googleChatMessageManifest,
  telegramMessageManifest,
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
