import type { ArtifactService } from "@tulipfarm/run-kernel";
import {
  chatRequestArtifactId,
  RUN_EXECUTOR_PRINCIPAL_REF,
  requestArtifactId,
  SUBAGENT_RUN_SOURCE,
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

/**
 * Which Run sources state their turn parameters directly, rather than through a derived Artifact.
 *
 * A sub-agent joins chat here because its spawner publishes the request Artifact under the same id
 * — which is how the helper inherits the spawning Agent's capability restrictions rather than
 * falling back to the default assistant, whose authority is wider than the Agent that spawned it.
 */
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
      authority.source === CHAT_SOURCE || authority.source === SUBAGENT_RUN_SOURCE
        ? requestArtifactId(authority.runId)
        : chatRequestArtifactId(authority.runId),
    reader: RUN_EXECUTOR_PRINCIPAL_REF,
    allowedClassifications: [],
    now,
  });
  return artifact.content as ChatRequestPayload;
}

/**
 * The chat request Artifact for this Run, or `undefined` when the Run published none.
 *
 * A Routine Run is not a conversation and fixes no turn parameters, so the read that is mandatory
 * for Chat is merely absent here. Callers must treat absence as "this Run states no Agent and no
 * per-turn autonomy" and fall back to what the Run's own authority recorded.
 */
export async function findChatRequest(
  artifacts: ArtifactService,
  authority: Pick<TurnAuthority, "businessId" | "runId" | "source">,
  now: Date
): Promise<ChatRequestPayload | undefined> {
  return readChatRequest(artifacts, authority, now).catch(() => undefined);
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
  // A Run with no Turn has no Conversation, and web chat is keyed by one. A sub-agent Run reasons
  // into an Artifact, so it gets no presentation target rather than one naming a Conversation
  // that does not exist.
  if (authority.turn === undefined) return undefined;
  return surfaces.contextFor(
    { channel: "web", surface: "chat" },
    `conversation:${authority.turn.conversationId}`
  );
}
