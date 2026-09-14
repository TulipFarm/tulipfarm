import {
  renderSurfaceText,
  type SurfaceRenderer,
  sameTarget,
  truncateSurfaceText,
  validateSurfaceArtifact,
} from "@tulipfarm/surface";
import { discordMessageManifest } from "./manifest";

export interface DiscordButton {
  readonly type: 2;
  readonly style: 1;
  readonly label: string;
  readonly custom_id: string;
}

export interface DiscordMessagePayload {
  readonly content: string;
  readonly components?: readonly {
    readonly type: 1;
    readonly components: readonly DiscordButton[];
  }[];
}

function actionRows(buttons: readonly DiscordButton[]): DiscordMessagePayload["components"] {
  const rows: Array<{ readonly type: 1; readonly components: readonly DiscordButton[] }> = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push({ type: 1, components: buttons.slice(index, index + 5) });
  }
  return rows;
}

export const discordMessageRenderer: SurfaceRenderer<DiscordMessagePayload> = {
  target: { channel: "discord", surface: "message" },
  manifest: discordMessageManifest,
  preflight(artifact) {
    const issues = [...validateSurfaceArtifact(artifact, [], discordMessageManifest)];
    if (!sameTarget(artifact.target, this.target)) {
      issues.push({
        code: "component_unsupported",
        path: "/target",
        message: "Artifact target does not match this Discord renderer.",
      });
    }
    return issues;
  },
  render(artifact, context) {
    const rendered = renderSurfaceText(artifact, context);
    const buttons = rendered.actions
      .filter((item): item is typeof item & { handle: string } => item.handle !== undefined)
      .map((item) => ({
        type: 2 as const,
        style: 1 as const,
        label: truncateSurfaceText(item.label, 80),
        custom_id: truncateSurfaceText(item.handle, 100),
      }));
    return {
      content: truncateSurfaceText(rendered.text || "Presentation unavailable.", 2_000),
      ...(buttons.length === 0 ? {} : { components: actionRows(buttons) }),
    };
  },
  update(_previous, artifact, context) {
    return this.render(artifact, context);
  },
};
