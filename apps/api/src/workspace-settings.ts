import { authenticateRoutes } from './authenticated-routes.ts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { createWorkspaceSettingsService, WorkspaceSettingsError } from '@tulipfarm/workspaces/settings';
import { ActionReviewError, createActionReviewService } from '@tulipfarm/workspaces/action-review';
import {
  actionReviewSettingsSchema,
  previewReviewSchema,
  reviewPreviewSchema,
  saveReviewSchema,
} from '@tulipfarm/workspaces/action-review-contracts';
import {
  deleteWorkspaceReceiptSchema,
  deleteWorkspaceSchema,
  renameWorkspaceReceiptSchema,
  renameWorkspaceSchema,
  setWorkspaceIconReceiptSchema,
  setWorkspaceIconSchema,
  workspaceSettingsReceiptSchema,
  workspaceSettingsSchema,
} from '@tulipfarm/workspaces/settings-contracts';
import { authConfig, type registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';
import { modelAvailabilityReceiptSchema } from '@tulipfarm/agents/model-policy-contracts';

const params = z.object({ workspaceId: z.uuid() });
const recoveryParams = params.extend({ requestId: z.uuid() });
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input' });
const errorSchema = json(z.object({ error: z.string() }));
// Fastify's default validator removes fields while trying union branches. Parse the chosen mode without mutation.
const reviewValidator =
  (body: z.ZodType) =>
  ({ httpPart }: { httpPart?: string }) =>
  (value: unknown) => {
    const parsed = (httpPart === 'body' ? body : params).safeParse(value);
    return parsed.success ? { value: parsed.data } : { error: parsed.error };
  };

export function registerWorkspaceSettings(
  app: FastifyInstance,
  dependencies: Parameters<typeof createWorkspaceSettingsService>[0] & {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
  },
) {
  const service = createWorkspaceSettingsService(dependencies);
  const review = createActionReviewService(dependencies);
  app.register(async routes => {
    const user = authenticateRoutes(routes, dependencies.auth, {
      origin: () => authConfig().webOrigin,
      userSchema: z.uuid(),
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (requestBoundaryError(error, reply)) return;
      if (error instanceof ActionReviewError)
        return reply.code(error.code === 'action-review-admin-required' ? 403 : 400).send({ error: error.code });
      if (error instanceof WorkspaceSettingsError)
        return reply.code(error.code === 'workspace-settings-not-found' ? 404 : 409).send({ error: error.code });
      if (error instanceof StorageUnavailableError) return reply.code(503).send({ error: 'workspace-unavailable' });
      if (error instanceof z.ZodError || (typeof error === 'object' && error !== null && 'validation' in error))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'workspace-settings-operation-failed' });
    });
    const schema = (operationId: string, response: z.ZodType, body?: z.ZodType, parameters: z.ZodType = params) => ({
      operationId,
      tags: ['Workspace settings'],
      params: json(parameters),
      ...(body ? { body: json(body) } : {}),
      response: {
        200: json(response),
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
        409: errorSchema,
        413: errorSchema,
        415: errorSchema,
        500: errorSchema,
        503: errorSchema,
      },
    });
    const base = '/workspaces/:workspaceId/settings';
    const reviewPath = `${base}/action-review`;
    routes.get(reviewPath, { schema: schema('getActionReviewV1', actionReviewSettingsSchema) }, request =>
      review.snapshot(params.parse(request.params).workspaceId, user(request)),
    );
    routes.post(
      // oxlint-disable-next-line tulipfarm/product-copy -- A stable route, not user-facing copy.
      `${reviewPath}/preview`,
      {
        schema: schema('previewActionReviewV1', reviewPreviewSchema, previewReviewSchema),
        validatorCompiler: reviewValidator(previewReviewSchema),
      },
      request => review.preview(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.put(
      reviewPath,
      {
        schema: schema('saveActionReviewV1', actionReviewSettingsSchema, saveReviewSchema),
        validatorCompiler: reviewValidator(saveReviewSchema),
      },
      request => review.save(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.get(base, { schema: schema('getWorkspaceSettingsV1', workspaceSettingsSchema) }, request =>
      service.snapshot(params.parse(request.params).workspaceId, user(request)),
    );
    routes.put(
      `${base}/name`,
      { schema: schema('renameWorkspaceV1', renameWorkspaceReceiptSchema, renameWorkspaceSchema) },
      request => service.rename(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.put(
      `${base}/icon`,
      { schema: schema('setWorkspaceIconV1', setWorkspaceIconReceiptSchema, setWorkspaceIconSchema) },
      request => service.setIcon(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.post(
      `${base}/delete`,
      { schema: schema('deleteWorkspaceV1', deleteWorkspaceReceiptSchema, deleteWorkspaceSchema) },
      request => service.delete(params.parse(request.params).workspaceId, user(request), request.body),
    );
    routes.get(
      '/workspace-settings/:workspaceId/commands/:requestId',
      { schema: schema('getWorkspaceSettingsCommandV1', workspaceSettingsReceiptSchema, undefined, recoveryParams) },
      request => {
        const { workspaceId, requestId } = recoveryParams.parse(request.params);
        return service.recovery(workspaceId, user(request), requestId);
      },
    );
    routes.get(
      '/workspace-settings/:workspaceId/model-availability/commands/:requestId',
      {
        schema: schema(
          'getAccountModelAvailabilityCommandV1',
          modelAvailabilityReceiptSchema,
          undefined,
          recoveryParams,
        ),
      },
      async request => {
        const { workspaceId, requestId } = recoveryParams.parse(request.params);
        const result = await dependencies.pool.query(
          "SELECT receipt FROM app.workspace_settings_commands WHERE workspace_id = $1 AND user_id = $2 AND request_id = $3 AND command->>'kind' = 'model-availability'",
          [workspaceId, user(request), requestId],
        );
        if (!result.rows[0]) throw new WorkspaceSettingsError('workspace-settings-not-found');
        return modelAvailabilityReceiptSchema.parse(result.rows[0].receipt);
      },
    );
  });
}
