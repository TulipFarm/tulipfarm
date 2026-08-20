import type { ArtifactService } from "@tulipfarm/run-kernel";
import {
  chatRequestArtifactId,
  RUN_EXECUTOR_PRINCIPAL_REF,
  requestArtifactId,
} from "@tulipfarm/run-kernel";
import type { PresentationContext } from "@tulipfarm/surface";
import type { TurnAuthority } from "./authority";
import type { ChannelDeliveryReader, SurfacePresentationPort } from "./ports";

/** The per-turn parameters a chat request carries (`CHAT_REQUEST_SCHEMA`). */
export interface ChatRequestPayload {
  readonly agentId?: string;
  readonly model?: string;
  readonly autonomy?: string;
  readonly hasTools?: boolean;
  readonly llmDecision?: boolean;
}

/** Which Run source states its turn parameters directly, rather than through a derived Artifact. */
const CHAT_SOURCE = "chat";

/** Reads the immutable request Artifact that fixed this turn's parameters. */
export async function readChatRequest(
  artifacts: ArtifactService,
  authority: Pick<TurnAuthority, "businessId" | "runId" | "source">,
  now: Date
): Promise<ChatRequestPayload> {
  const artifact = await artifacts.read({
    businessId: authority.businessId,
    artifactId:
      authority.source === CHAT_SOURCE
        ? requestArtifactId(authority.runId)
        : chatRequestArtifactId(authority.runId),
    reader: RUN_EXECUTOR_PRINCIPAL_REF,
    allowedClassifications: [],
    now,
  });
  return artifact.content as ChatRequestPayload;
}

/**
 * Resolves the presentation target from channel delivery correlation, falling back to web chat.
 * Without a renderer registry the process can render nothing, so it reports no presentation at
 * all rather than naming a target it could not draw.
 */
export async function presentationContextForAuthority(
  authority: TurnAuthority,
  surfaces?: SurfacePresentationPort,
  channelDeliveries?: ChannelDeliveryReader
): Promise<PresentationContext | undefined> {
  if (surfaces === undefined) return undefined;
  const delivery = await channelDeliveries?.find(authority.businessId, authority.runId);
  if (delivery?.provider === "slack") {
    return surfaces.contextFor({ channel: "slack", surface: "message" }, delivery.destination);
  }
  if (delivery?.provider === "telegram") {
    return surfaces.contextFor({ channel: "telegram", surface: "message" }, delivery.destination);
  }
  return surfaces.contextFor(
    { channel: "web", surface: "chat" },
    `conversation:${authority.turn.conversationId}`
  );
}
