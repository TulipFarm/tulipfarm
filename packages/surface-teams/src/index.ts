import {
  renderSurfaceText,
  type SurfaceRenderer,
  truncateSurfaceText,
  validateSurfaceArtifact,
} from "@tulipfarm/surface";
import { teamsMessageManifest } from "./manifest";

function truncateUtf8(value: string, maxBytes: number): string {
  let output = value;
  while (Buffer.byteLength(output, "utf8") > maxBytes) output = output.slice(0, -1);
  return output;
}

export interface TeamsMessagePayload {
  readonly type: "message";
  readonly attachments: readonly [
    {
      readonly contentType: "application/vnd.microsoft.card.adaptive";
      readonly content: {
        readonly type: "AdaptiveCard";
        readonly version: "1.5";
        readonly body: readonly [
          { readonly type: "TextBlock"; readonly text: string; readonly wrap: true },
        ];
        readonly actions?: readonly {
          readonly type: "Action.Submit";
          readonly title: string;
          readonly data: { readonly action: string; readonly value?: string };
        }[];
      };
    },
  ];
}

export const teamsMessageRenderer: SurfaceRenderer<TeamsMessagePayload> = {
  target: { channel: "teams", surface: "message" },
  manifest: teamsMessageManifest,
  preflight: (artifact) => validateSurfaceArtifact(artifact, [], teamsMessageManifest),
  render(artifact, context) {
    const rendered = renderSurfaceText(artifact, context);
    const actions = rendered.actions
      .filter((item): item is typeof item & { handle: string } => item.handle !== undefined)
      .slice(0, 6)
      .map((item) => ({
        type: "Action.Submit" as const,
        title: truncateSurfaceText(item.label, 100),
        data: { action: item.handle, ...(item.value === undefined ? {} : { value: item.value }) },
      }));
    return {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            version: "1.5",
            body: [{ type: "TextBlock", text: truncateUtf8(rendered.text, 20_000), wrap: true }],
            ...(actions.length === 0 ? {} : { actions }),
          },
        },
      ],
    };
  },
  update(_previous, artifact, context) {
    return this.render(artifact, context);
  },
};
