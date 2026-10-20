import { authenticateRoutes } from './authenticated-routes.ts';
import { routeValidation } from './route-validation.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import {
  ProviderFailure,
  WebhookKeyUnavailable,
  WebhookRejected,
  WorkflowConflict,
  type createWorkflows,
} from '@tulipfarm/workflows';
import {
  activationSchema,
  commandSchema,
  webhookDeliveryLogSchema,
  webhookKeySchema,
  webhookKeyIssuedSchema,
  webhookOutcomeSchema,
  webhookTestSchema,
  providerUpdateSchema,
  idSchema,
  payloadSchema,
  runHistoryPageSchema,
  runHistoryQuerySchema,
  saveSchema,
  startSchema,
  workflowSchema,
  providerIntegrationInputSchema,
  providerIntegrationSchema,
  providerStatusSchema,
} from '@tulipfarm/workflows/contracts';
import {
  grantsSchema,
  sharingSchema,
  providerSharingSchema,
  sharingCandidatesSchema,
  sponsorshipSchema,
  acceptSponsorshipSchema,
} from '@tulipfarm/workflows/contracts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { authConfig, type registerAuth } from './auth.ts';
import { requestBoundaryError } from './security.ts';
import { webhookRefusal } from './abuse.ts';
import {
  providerTestInputSchema,
  providerTestResultSchema,
  providerResourceInputSchema,
  providerResourceResultSchema,
} from '@tulipfarm/workflows/contracts';
import {
  calendarRangeSchema,
  calendarFollowSchema,
  workflowCalendarSchema,
} from '@tulipfarm/workflows/calendar-contracts';
import {
  definitionQuerySchema,
  definitionViewSchema,
  runDetailSchema,
  type workflowPersonSchema,
} from '@tulipfarm/workflows/contracts';

const workspace = z.strictObject({ workspaceId: idSchema });
const workflow = workspace.extend({ workflowId: idSchema });
const run = workflow.extend({ runId: idSchema });
const validation = routeValidation({ missing: 'Missing workflow validator', invalid: error => error });
const { json } = validation;
const error = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };
function schema(operationId: string, summary: string, params: z.ZodType, response: z.ZodType, body?: z.ZodType) {
  return {
    operationId,
    summary,
    tags: ['Workflows'],
    params: json(params),
    ...(body ? { body: json(body) } : {}),
    response: {
      200: json(response),
      400: error,
      401: error,
      403: error,
      404: error,
      409: error,
      413: error,
      429: error,
      500: error,
      503: error,
    },
  };
}
const receiveOperation = 'receiveWorkflowWebhookV1',
  testOperation = 'sendWorkflowWebhookTestV1';
function errorCode(payload: unknown) {
  if (typeof payload !== 'string') return null;
  try {
    return z.object({ error: webhookOutcomeSchema }).parse(JSON.parse(payload)).error;
  } catch {
    return null;
  }
}
export function registerWorkflows(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    service: ReturnType<typeof createWorkflows>;
    identity?: Pool;
  },
) {
  app.register(async routes => {
    const rejections = new WeakMap<FastifyRequest, WebhookRejected>();
    validation.install(routes, true);
    // Raw webhooks accept any JSON value, so a text body must not become a string input.
    routes.removeContentTypeParser('text/plain');
    const user = authenticateRoutes(routes, dependencies.auth, {
      origin: () => authConfig().webOrigin,
      publicOperation: receiveOperation,
    });
    routes.setErrorHandler((failure, request, reply) => {
      if (failure instanceof WebhookRejected) rejections.set(request, failure);
      if (failure instanceof z.ZodError) {
        const issues = failure.issues.filter(
          issue => issue.code === 'custom' && issue.params?.workflowOutputPath === true,
        );
        if (issues.length)
          return reply.code(400).send({
            error: 'invalid-output-path',
            issues: issues.map(issue => ({ path: issue.path, message: issue.message })),
          });
      }
      if (requestBoundaryError(failure, reply)) return;
      if (failure instanceof AccessDenied) return reply.code(404).send({ error: 'workflow-not-found' });
      if (failure instanceof WorkflowConflict) return reply.code(409).send({ error: failure.message });
      if (failure instanceof ProviderFailure)
        return reply.header('Cache-Control', 'no-store').code(409).send({ error: failure.code });
      if (failure instanceof StorageUnavailableError) return reply.code(503).send({ error: 'workflows-unavailable' });
      if (failure instanceof WebhookKeyUnavailable) {
        routes.log.error('A webhook signing key could not be unsealed with the integration credential keyring');
        return reply.code(503).send({ error: 'webhook-key-unavailable' });
      }
      if (failure instanceof z.ZodError && failure.issues.some(issue => issue.message === 'Payload exceeds 32 KiB'))
        return reply.code(413).send({ error: 'run-input-too-large' });
      if (failure instanceof z.ZodError || (typeof failure === 'object' && failure !== null && 'validation' in failure))
        return reply.code(400).send({ error: 'invalid-request' });
      return reply.code(500).send({ error: 'workflow-operation-failed' });
    });
    const service = dependencies.service;
    async function nameActor<T extends { actor: z.infer<typeof workflowPersonSchema> | null }>(result: T): Promise<T> {
      if (result.actor && dependencies.identity) {
        const person = (
          await dependencies.identity.query('SELECT name FROM app.users WHERE id=$1', [result.actor.userId])
        ).rows[0];
        result.actor.name = person ? z.string().parse(person.name) : 'Former workspace member';
      }
      return result;
    }
    const base = '/workspaces/:workspaceId/workflows';
    routes.get(
      `${base}/calendar`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'workflowCalendarV1',
            'Read personal and followed workflow occurrences and pending actions',
            workspace,
            workflowCalendarSchema,
          ),
          querystring: json(calendarRangeSchema),
        },
      },
      request => service.calendar(workspace.parse(request.params).workspaceId, user(request), request.query),
    );
    routes.put(
      `${base}/:workflowId/calendar-follow`,
      {
        logLevel: 'silent',
        schema: schema(
          'followWorkflowCalendarV1',
          'Follow a readable workflow without granting access to its runs',
          workflow,
          calendarFollowSchema,
          calendarFollowSchema,
        ),
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.followCalendar(workspaceId, user(request), workflowId, request.body);
      },
    );
    routes.get(
      `${base}/recent`,
      {
        schema: schema(
          'recentWorkflowsV1',
          'List the latest three readable current workflows',
          workspace,
          z.array(z.object({ id: idSchema, name: z.string() })),
        ),
      },
      request => service.recent(workspace.parse(request.params).workspaceId, user(request)),
    );
    const saved = z.object({ saved: z.boolean() });
    const integration = workspace.extend({ integrationId: idSchema });
    routes.get(
      `${base}/sharing-candidates`,
      {
        schema: schema(
          'workflowSharingCandidatesV1',
          'Find people and your teams for sharing',
          workspace,
          sharingCandidatesSchema,
        ),
      },
      async request => {
        const candidates = await service.candidates(workspace.parse(request.params).workspaceId, user(request));
        if (dependencies.identity) {
          const people = z
            .array(z.object({ id: z.string(), name: z.string(), email: z.string() }))
            .parse(
              (
                await dependencies.identity.query('SELECT id,name,email FROM app.users WHERE id=ANY($1)', [
                  candidates.people.map(person => person.userId),
                ])
              ).rows,
            );
          const names = new Map(people.map(person => [person.id, `${person.name} (${person.email})`]));
          candidates.people = candidates.people.map(person => ({
            ...person,
            name: names.get(person.userId) ?? 'Workspace member',
          }));
        }
        return candidates;
      },
    );
    routes.get(
      `${base}/:workflowId/grants`,
      { schema: schema('workflowGrantsV1', 'Read workflow sharing', workflow, grantsSchema) },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.grants(workspaceId, user(request), workflowId);
      },
    );
    routes.put(
      `${base}/:workflowId/grants`,
      { schema: schema('shareWorkflowV1', 'Share a workflow definition', workflow, saved, sharingSchema) },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.share(workspaceId, user(request), workflowId, request.body);
      },
    );
    routes.put(
      `${base}/:workflowId/sponsorship`,
      {
        schema: schema(
          'sponsorWorkflowV1',
          'Sponsor unattended runs and select their history audience',
          workflow,
          workflowSchema,
          sponsorshipSchema,
        ),
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.sponsorship(workspaceId, user(request), workflowId, request.body);
      },
    );
    routes.post(
      `${base}/:workflowId/sponsorship/accept`,
      {
        schema: schema(
          'acceptWorkflowSponsorshipV1',
          'Accept named workflow sponsorship',
          workflow,
          workflowSchema,
          acceptSponsorshipSchema,
        ),
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.acceptSponsorship(workspaceId, user(request), workflowId, request.body);
      },
    );
    routes.get(
      `${base}/provider-integrations/:integrationId/grants`,
      { schema: schema('workflowProviderGrantsV1', 'Read provider sharing', integration, grantsSchema) },
      request => {
        const { workspaceId, integrationId } = integration.parse(request.params);
        return service.providers.grants(workspaceId, user(request), integrationId);
      },
    );
    routes.put(
      `${base}/provider-integrations/:integrationId/grants`,
      {
        schema: schema(
          'shareWorkflowProviderV1',
          'Share provider management or use',
          integration,
          saved,
          providerSharingSchema,
        ),
      },
      request => {
        const { workspaceId, integrationId } = integration.parse(request.params);
        return service.providers.share(workspaceId, user(request), integrationId, request.body);
      },
    );
    routes.get(
      `${base}/provider-integrations`,
      {
        logLevel: 'silent',
        schema: schema(
          'listWorkflowProviderIntegrationsV1',
          'List consented provider sources',
          workspace,
          z.array(providerIntegrationSchema),
        ),
      },
      request => service.providers.list(workspace.parse(request.params).workspaceId, user(request)),
    );
    routes.post(
      `${base}/provider-integrations/test`,
      {
        logLevel: 'silent',
        bodyLimit: 16384,
        schema: schema(
          'testWorkflowProviderIntegrationV1',
          'Check an unsaved provider token and source without storing it',
          workspace,
          providerTestResultSchema,
          providerTestInputSchema,
        ),
      },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return service.providers.test(workspace.parse(request.params).workspaceId, user(request), request.body);
      },
    );
    routes.post(
      `${base}/provider-integrations/resources`,
      {
        logLevel: 'silent',
        bodyLimit: 16384,
        schema: schema(
          'listWorkflowProviderResourcesV1',
          'List source choices with an unsaved provider token',
          workspace,
          providerResourceResultSchema,
          providerResourceInputSchema,
        ),
      },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return service.providers.resources(workspace.parse(request.params).workspaceId, user(request), request.body);
      },
    );
    routes.post(
      `${base}/provider-integrations`,
      {
        logLevel: 'silent',
        bodyLimit: 16384,
        schema: schema(
          'createWorkflowProviderIntegrationV1',
          'Connect a private provider source',
          workspace,
          saved,
          providerIntegrationInputSchema,
        ),
      },
      request => service.providers.create(workspace.parse(request.params).workspaceId, user(request), request.body),
    );
    const integrationUpdate = providerUpdateSchema;
    routes.patch(
      `${base}/provider-integrations/:integrationId`,
      {
        logLevel: 'silent',
        bodyLimit: 8192,
        schema: schema(
          'updateWorkflowProviderIntegrationV1',
          'Rotate or disable a provider credential',
          integration,
          saved,
          integrationUpdate,
        ),
      },
      request => {
        const { workspaceId, integrationId } = integration.parse(request.params);
        return service.providers.update(workspaceId, user(request), integrationId, request.body);
      },
    );
    routes.get(
      `${base}/:workflowId/provider-status`,
      {
        logLevel: 'silent',
        schema: schema(
          'workflowProviderStatusV1',
          'Read durable provider ingestion status',
          workflow,
          providerStatusSchema,
        ),
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.providers.status(workspaceId, user(request), workflowId);
      },
    );
    const listQuery = z.strictObject({ archived: z.enum(['true', 'false']).optional() });
    routes.get(
      base,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'listWorkflowsV1',
            'List current workflows shared with the current member, or archived ones with archived=true',
            workspace,
            z.array(workflowSchema),
          ),
          querystring: json(listQuery),
        },
      },
      request =>
        service.list(workspace.parse(request.params).workspaceId, user(request), {
          archived: listQuery.parse(request.query).archived === 'true',
        }),
    );
    routes.get(
      `${base}/:workflowId`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'workflowDefinitionV1',
            'Read an authorized exact workflow definition',
            workflow,
            definitionViewSchema,
          ),
          querystring: json(definitionQuerySchema),
        },
      },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return nameActor(await service.definition(workspaceId, user(request), workflowId, request.query));
      },
    );
    routes.put(
      `${base}/:workflowId`,
      {
        logLevel: 'silent',
        bodyLimit: 131072,
        schema: schema('saveWorkflowV1', 'Save an immutable workflow revision', workflow, workflowSchema, saveSchema),
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.save(workspaceId, user(request), workflowId, request.body);
      },
    );
    const activation = activationSchema;
    routes.post(
      `${base}/:workflowId/activation`,
      {
        logLevel: 'silent',
        schema: schema(
          'activateWorkflowV1',
          'Activate or disable an exact workflow revision',
          workflow,
          workflowSchema,
          activation,
        ),
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.activate(workspaceId, user(request), workflowId, request.body);
      },
    );
    routes.post(
      `${base}/:workflowId/archive`,
      {
        logLevel: 'silent',
        schema: schema(
          'archiveWorkflowV1',
          'Archive a workflow, stopping its triggers and unfinished runs while keeping run history',
          workflow,
          z.object({ archived: z.literal(true) }),
          commandSchema,
        ),
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.archive(workspaceId, user(request), workflowId, request.body);
      },
    );
    routes.post(
      `${base}/:workflowId/row-events/cancel`,
      {
        logLevel: 'silent',
        schema: schema(
          'cancelWorkflowRowEventsV1',
          'Explicitly cancel retained row events that have not started a run',
          workflow,
          workflowSchema,
          commandSchema,
        ),
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.cancelRowEvents(workspaceId, user(request), workflowId, request.body);
      },
    );
    routes.post(
      `${base}/:workflowId/runs`,
      {
        logLevel: 'silent',
        bodyLimit: 65536,
        schema: schema(
          'startWorkflowV1',
          'Manually start any active workflow',
          workflow,
          z.object({ runId: idSchema }),
          startSchema,
        ),
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.start(workspaceId, user(request), workflowId, request.body);
      },
    );
    routes.get(
      `${base}/:workflowId/runs`,
      {
        logLevel: 'silent',
        schema: {
          ...schema(
            'workflowHistoryV1',
            'Read one page of workflow runs and step receipts, newest first, optionally filtered by status. Without a filter the first page also lists every unfinished run.',
            workflow,
            runHistoryPageSchema,
          ),
          querystring: json(runHistoryQuerySchema),
        },
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.history(workspaceId, user(request), workflowId, request.query);
      },
    );
    routes.get(
      `${base}/:workflowId/runs/:runId`,
      {
        logLevel: 'silent',
        schema: schema(
          'workflowRunDetailV1',
          'Read the pinned definition, actor and safe receipts for a workflow run',
          run,
          runDetailSchema,
        ),
      },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const { workspaceId, workflowId, runId } = run.parse(request.params);
        return nameActor(await service.runDetail(workspaceId, user(request), workflowId, runId));
      },
    );
    const response = z.strictObject({ stepId: z.string().max(48), responseId: idSchema, output: payloadSchema });
    routes.post(
      `${base}/:workflowId/runs/:runId/input`,
      {
        logLevel: 'silent',
        bodyLimit: 65536,
        schema: schema('respondWorkflowV1', 'Answer a durable workflow human-input step', run, saved, response),
      },
      request => {
        const { workspaceId, workflowId, runId } = run.parse(request.params);
        return service.respond(workspaceId, user(request), workflowId, runId, request.body);
      },
    );
    routes.post(
      `${base}/:workflowId/runs/:runId/cancel`,
      {
        logLevel: 'silent',
        schema: schema('cancelWorkflowV1', 'Cancel unfinished workflow work', run, saved, z.strictObject({})),
      },
      request => {
        const { workspaceId, workflowId, runId } = run.parse(request.params);
        return service.cancel(workspaceId, user(request), workflowId, runId);
      },
    );
    routes.put(
      `${base}/:workflowId/webhook-key`,
      {
        logLevel: 'silent',
        schema: schema(
          'rotateWorkflowWebhookV1',
          'Generate a bearer or HMAC signing webhook key, returned once, and keep the previous key valid for a grace period',
          workflow,
          webhookKeyIssuedSchema,
          webhookKeySchema,
        ),
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.webhookKey(workspaceId, user(request), workflowId, request.body);
      },
    );
    routes.post(
      `${base}/:workflowId/webhook-key/revoke-previous`,
      {
        logLevel: 'silent',
        schema: schema(
          'revokePreviousWorkflowWebhookKeyV1',
          'Stop accepting the previous webhook key before its grace period ends',
          workflow,
          workflowSchema,
          commandSchema,
        ),
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.revokePreviousWebhookKey(workspaceId, user(request), workflowId, request.body);
      },
    );
    routes.get(
      `${base}/:workflowId/webhook-deliveries`,
      {
        logLevel: 'silent',
        schema: schema(
          'workflowWebhookDeliveriesV1',
          'Read the recent webhook delivery log: time, outcome, request ID, body size, and run',
          workflow,
          webhookDeliveryLogSchema,
        ),
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params);
        return service.webhookDeliveries(workspaceId, user(request), workflowId);
      },
    );
    routes.register(async receiver => {
      // HMAC signatures cover the exact bytes sent, so the parsed body keeps its raw source beside it.
      const raw = new WeakMap<FastifyRequest, Buffer>(),
        parse = receiver.getDefaultJsonParser('error', 'error');
      const admitted = new WeakMap<FastifyRequest, { runId: string; replayed: boolean }>();
      // Only verified deliveries spend a workflow's budget, so its 429 names a workflow that exists; it is logged once a minute so a flood adds no write per request.
      // Source and workspace budgets refuse before any key check, so logging those would let anyone write to workspace storage with made-up workflow IDs.
      const quietUntil = new Map<string, number>();
      receiver.addHook('onSend', async (request, reply, payload) => {
        const operation = request.routeOptions.schema?.operationId,
          target = workflow.safeParse(request.params);
        if ((operation !== receiveOperation && operation !== testOperation) || !target.success) return payload;
        const test = operation === testOperation,
          status = reply.statusCode,
          refusal = webhookRefusal(request);
        if (refusal && refusal !== 'workflow-webhook') return payload;
        // A test send is the workflow's delivery once a manager's request reached admission: it started a run, was refused there, or failed.
        if (test && status !== 200 && status !== 409 && status < 500) return payload;
        const { workspaceId, workflowId } = target.data;
        if (status === 429) {
          const now = Date.now(),
            key = `${workspaceId}:${workflowId}`;
          if ((quietUntil.get(key) ?? 0) > now) return payload;
          if (quietUntil.size >= 10000)
            for (const [held, until] of quietUntil) if (until <= now) quietUntil.delete(held);
          quietUntil.set(key, now + 60000);
        }
        const run = admitted.get(request);
        const outcome = run
          ? run.replayed
            ? 'duplicate'
            : 'accepted'
          : (rejections.get(request)?.reason ?? errorCode(payload) ?? `http-${status}`);
        // Unavailable storage would refuse the log write too, and the sender would wait for it.
        if (outcome === 'workflows-unavailable') return payload;
        const length = Number(request.headers['content-length']);
        try {
          await service.recordWebhookDelivery(workspaceId, workflowId, {
            status,
            outcome,
            test,
            runId: run?.runId ?? null,
            bodyBytes: test
              ? null
              : (raw.get(request)?.length ??
                (Number.isSafeInteger(length) && length >= 0 ? Math.min(length, 2147483647) : null)),
            ...(test
              ? { requestId: webhookTestSchema.safeParse(request.body).data?.requestId ?? null }
              : { sent: { body: request.body, headers: request.headers } }),
          });
        } catch {
          receiver.log.error('A webhook delivery could not be recorded in the delivery log');
        }
        return payload;
      });
      receiver.removeContentTypeParser('application/json');
      receiver.addContentTypeParser(
        'application/json',
        { parseAs: 'buffer', bodyLimit: 65536 },
        (request, body, done) => {
          const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
          parse(request, bytes.toString('utf8'), (failure: Error | null, value?: unknown) => {
            if (!failure) raw.set(request, bytes);
            done(failure, value);
          });
        },
      );
      receiver.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'buffer', bodyLimit: 65536 },
        (request, body, done) => {
          const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body),
            fields: Record<string, string | string[]> = Object.create(null);
          raw.set(request, bytes);
          for (const [name, value] of new URLSearchParams(bytes.toString('utf8'))) {
            const existing = fields[name];
            fields[name] =
              existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
          }
          done(null, fields);
        },
      );
      receiver.post(
        `${base}/:workflowId/webhook`,
        {
          logLevel: 'silent',
          bodyLimit: 65536,
          schema: schema(
            receiveOperation,
            'Receive a workflow event authenticated with a bearer key or provider signature, as a JSON or form-encoded requestId envelope or raw trigger payload',
            workflow,
            z.object({ runId: idSchema }),
            z.json(),
          ),
        },
        async request => {
          const { workspaceId, workflowId } = workflow.parse(request.params);
          const body = raw.get(request);
          const run = await service.webhook(workspaceId, workflowId, {
            body: request.body,
            headers: request.headers,
            ...(body ? { raw: body } : {}),
          });
          admitted.set(request, run);
          return { runId: run.runId };
        },
      );
      receiver.post(
        `${base}/:workflowId/webhook-test`,
        {
          logLevel: 'silent',
          bodyLimit: 1024,
          schema: schema(
            testOperation,
            'Send a sample event shaped for the active webhook trigger through webhook admission, recorded in the delivery log as a test',
            workflow,
            z.object({ runId: idSchema }),
            webhookTestSchema,
          ),
        },
        async request => {
          const { workspaceId, workflowId } = workflow.parse(request.params);
          const run = await service.testWebhook(workspaceId, user(request), workflowId, request.body);
          admitted.set(request, run);
          return { runId: run.runId };
        },
      );
    });
    const event = startSchema.extend({ name: z.string().max(48) });
    routes.post(
      `${base}/:workflowId/events`,
      {
        logLevel: 'silent',
        bodyLimit: 65536,
        schema: schema(
          'emitWorkflowEventV1',
          'Send an authenticated microapp event',
          workflow,
          z.object({ runId: idSchema }),
          event,
        ),
      },
      request => {
        const { workspaceId, workflowId } = workflow.parse(request.params),
          body = event.parse(request.body);
        return service.event(workspaceId, user(request), workflowId, body.name, {
          requestId: body.requestId,
          input: body.input,
        });
      },
    );
  });
}
