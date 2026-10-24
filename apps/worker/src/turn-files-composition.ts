import { routeCapabilities, inferenceRouteSchema } from '@tulipfarm/agents/inference';
import { pinTurnImageModels } from '@tulipfarm/agents/image-settings';
import { modelImageLimits } from '@tulipfarm/config';
import { createAttachments, type AttachmentBytes } from '@tulipfarm/conversations/attachments';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import type { TurnFiles } from '@tulipfarm/conversations/turn-files';
import { MediaRecognitionUnavailable } from '@tulipfarm/memory-core/parser/media-contracts';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { chatReplyModel } from './conversation-model.ts';
import { createMediaRecognizer, recognitionModel } from './media-recognition.ts';

/**
 * How chat reads attached and referenced files while the `images` flag is on. Recognition reuses the Knowledge media
 * recognizer on the turn's pinned recognition model and is charged as the requester's Knowledge credits.
 */
export function chatTurnFiles(
  runtime: ConversationRuntime,
  objects: { attachments: Pick<AttachmentBytes, 'read'> },
): TurnFiles {
  const attachments = createAttachments(runtime, {
    read: (...args) => objects.attachments.read(...args),
    putIfAbsent: () => Promise.reject(new Error('attachments-read-only')),
    remove: () => Promise.reject(new Error('attachments-read-only')),
  });
  return {
    enabled: workspaceId => isFeatureEnabled('images', null, { id: workspaceId }),
    family(familyId) {
      const model = chatReplyModel(familyId);
      if (!model) throw new Error('conversation-model-unavailable');
      const route = inferenceRouteSchema.parse(model.route);
      return {
        imageInput: routeCapabilities(route).imageInput,
        maxInputTokens: model.price.maxInputTokens,
        ...modelImageLimits(route.provider, route.model),
      };
    },
    async recognise(request, context) {
      const recognizer = createMediaRecognizer(
        runtime,
        {
          workspaceId: context.workspaceId,
          memberId: context.requester.membershipId,
          flowId: `chat:${context.conversationId}:${context.turnId}`,
        },
        () => recognitionModel(context.model),
      );
      if (!recognizer) throw new MediaRecognitionUnavailable('The model that reads images is not served');
      return recognizer.recognize(request);
    },
    attachments,
    pin: (tx, familyId) => pinTurnImageModels(tx, familyId),
  };
}
