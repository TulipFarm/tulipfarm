import { routeCapabilities, inferenceRouteSchema } from '@tulipfarm/agents/inference';
import { pinTurnImageModels } from '@tulipfarm/agents/image-settings';
import { defaultImageInputLimits, modelImageLimits } from '@tulipfarm/config';
import { createAttachments, type AttachmentBytes } from '@tulipfarm/conversations/attachments';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import { recognisingExtract, type TurnFiles } from '@tulipfarm/conversations/turn-files';
import type { TaskFileExtraction } from '@tulipfarm/agents/task-runtime';
import { createRecognitionCache } from '@tulipfarm/knowledge';
import type { MediaRecognizer } from '@tulipfarm/memory-core/parser/media-contracts';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { chatReplyModel } from './conversation-model.ts';
import {
  createMediaRecognizer,
  recognitionModel,
  workspaceRecognitionModel,
  type WorkspaceRecognitionModel,
} from './media-recognition.ts';

/** Recognitions in flight at once for one chat turn or task step, across all of its file reads. */
export const turnRecognitionConcurrency = 4;

const turns = new Map<string, { active: number; waiting: (() => void)[] }>();

/** Wraps a recognizer so every recognizer of one turn or task shares one `turnRecognitionConcurrency` bound. */
function turnLimited(turn: string, recognizer: MediaRecognizer): MediaRecognizer {
  return {
    modelId: recognizer.modelId,
    promptVersion: recognizer.promptVersion,
    async recognize(request) {
      let slot = turns.get(turn);
      if (!slot) turns.set(turn, (slot = { active: 0, waiting: [] }));
      // A released slot passes straight to the next waiter, so a newcomer can never take it in between.
      if (slot.active < turnRecognitionConcurrency) slot.active += 1;
      else await new Promise<void>(resolve => slot.waiting.push(resolve));
      try {
        return await recognizer.recognize(request);
      } finally {
        const next = slot.waiting.shift();
        if (next) next();
        else if (!(slot.active -= 1)) turns.delete(turn);
      }
    },
  };
}

/**
 * How chat reads attached and referenced files while the `images` flag is on. Recognition reuses the Knowledge media
 * recognizer and the workspace recognition cache on the turn's pinned recognition model, and is charged as the
 * requester's Knowledge credits.
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
    recognition(context) {
      const recognizer = createMediaRecognizer(
        runtime,
        {
          workspaceId: context.workspaceId,
          memberId: context.requester.membershipId,
          flowId: `chat:${context.conversationId}:${context.turnId}`,
        },
        () => recognitionModel(context.model),
      );
      return (
        recognizer && {
          recognizer: turnLimited(`chat:${context.conversationId}:${context.turnId}`, recognizer),
          cache: createRecognitionCache(runtime, context.workspaceId),
        }
      );
    },
    attachments,
    pin: (tx, familyId) => pinTurnImageModels(tx, familyId),
  };
}

/**
 * How tasks read Files and Drive inputs: under the workspace `images` flag, the chat reader on the workspace
 * recognition model, sharing the recognition cache and charged to the owner as Knowledge credits. Without the flag,
 * the legacy text extraction.
 */
export function taskFileExtraction(
  runtime: ConversationRuntime,
  model: WorkspaceRecognitionModel = workspaceRecognitionModel(runtime),
): TaskFileExtraction {
  return async scope => {
    if (!(await isFeatureEnabled('images', null, { id: scope.workspaceId }))) return undefined;
    const resolved = await model(scope.workspaceId);
    const recognizer = createMediaRecognizer(
      runtime,
      { workspaceId: scope.workspaceId, memberId: scope.membershipId, flowId: `task:${scope.taskId}` },
      () => resolved,
    );
    const route = resolved && inferenceRouteSchema.parse(resolved.route);
    return recognisingExtract(
      recognizer && {
        recognizer: turnLimited(`task:${scope.taskId}`, recognizer),
        cache: createRecognitionCache(runtime, scope.workspaceId),
      },
      route ? modelImageLimits(route.provider, route.model).maxImageBytes : defaultImageInputLimits.maxImageBytes,
    );
  };
}
