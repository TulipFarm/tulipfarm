import {
  renderSurfaceText,
  type SurfaceRenderer,
  truncateSurfaceText,
  validateSurfaceArtifact,
} from "@tulipfarm/surface";
import { telegramMessageManifest } from "./manifest";

export interface TelegramMessagePayload {
  readonly text: string;
  readonly reply_markup?: {
    readonly inline_keyboard: readonly (readonly [
      {
        readonly text: string;
        readonly callback_data: string;
      },
    ])[];
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let output = value;
  while (Buffer.byteLength(output, "utf8") > maxBytes) output = output.slice(0, -1);
  return output;
}

export const telegramMessageRenderer: SurfaceRenderer<TelegramMessagePayload> = {
  target: { channel: "telegram", surface: "message" },
  manifest: telegramMessageManifest,
  preflight: (artifact) => validateSurfaceArtifact(artifact, [], telegramMessageManifest),
  render(artifact, context) {
    const rendered = renderSurfaceText(artifact, context);
    const buttons = rendered.actions
      .filter((item): item is typeof item & { handle: string } => item.handle !== undefined)
      .map(
        (item) =>
          [
            {
              text: truncateSurfaceText(item.label, 64),
              callback_data: truncateUtf8(item.handle, 64),
            },
          ] as const
      );
    return {
      text: truncateSurfaceText(rendered.text || "Presentation unavailable.", 4_096),
      ...(buttons.length === 0 ? {} : { reply_markup: { inline_keyboard: buttons } }),
    };
  },
  update(_previous, artifact, context) {
    return this.render(artifact, context);
  },
};
