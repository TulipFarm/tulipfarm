import {
  renderSurfaceText,
  type SurfaceRenderer,
  truncateSurfaceText,
  validateSurfaceArtifact,
} from "@tulipfarm/surface";
import { googleChatMessageManifest } from "./manifest";

export interface GoogleChatMessagePayload {
  readonly text: string;
  readonly cardsV2?: readonly [
    {
      readonly cardId: string;
      readonly card: {
        readonly sections: readonly [
          {
            readonly widgets: readonly [
              {
                readonly buttonList: {
                  readonly buttons: readonly {
                    readonly text: string;
                    readonly onClick: {
                      readonly action: {
                        readonly function: string;
                        readonly parameters?: readonly {
                          readonly key: string;
                          readonly value: string;
                        }[];
                      };
                    };
                  }[];
                };
              },
            ];
          },
        ];
      };
    },
  ];
}

export const googleChatMessageRenderer: SurfaceRenderer<GoogleChatMessagePayload> = {
  target: { channel: "google-chat", surface: "message" },
  manifest: googleChatMessageManifest,
  preflight: (artifact) => validateSurfaceArtifact(artifact, [], googleChatMessageManifest),
  render(artifact, context) {
    const rendered = renderSurfaceText(artifact, context);
    const buttons = rendered.actions
      .filter((item): item is typeof item & { handle: string } => item.handle !== undefined)
      .slice(0, 10)
      .map((item) => ({
        text: truncateSurfaceText(item.label, 100),
        onClick: {
          action: {
            function: item.handle,
            ...(item.value === undefined
              ? {}
              : { parameters: [{ key: "value", value: item.value }] }),
          },
        },
      }));
    return {
      text: truncateSurfaceText(rendered.text, 4_096),
      ...(buttons.length === 0
        ? {}
        : {
            cardsV2: [
              {
                cardId: artifact.id,
                card: { sections: [{ widgets: [{ buttonList: { buttons } }] }] },
              },
            ],
          }),
    };
  },
  update(_previous, artifact, context) {
    return this.render(artifact, context);
  },
};
