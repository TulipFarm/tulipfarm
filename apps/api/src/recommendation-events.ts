import { PassThrough } from 'node:stream';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessDenied, lockAuthorization, resolveHuman } from '@tulipfarm/access';
import { commonCompatibility, StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import type { RecommendationStreamEvent } from '@tulipfarm/recommendations/contracts';
import type { registerAuth } from './auth.ts';
import type { ConversationEventHub } from './conversation-events.ts';

export function registerRecommendationEvents(
  app: FastifyInstance,
  dependencies: {
    runtime: WorkspaceRuntime;
    auth: Pick<ReturnType<typeof registerAuth>['auth'], 'api'>;
    events: ConversationEventHub;
    eligible(workspaceId: string, userId: string): Promise<boolean>;
  },
) {
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const end of streams) end();
  });
  const error = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };
  app.get(
    '/workspaces/:workspaceId/recommendations/events',
    {
      logLevel: 'silent',
      schema: {
        operationId: 'streamRecommendationEventsV1',
        summary: 'Stream private recommendation change identifiers',
        tags: ['Conversations'],
        params: z.toJSONSchema(z.object({ workspaceId: z.uuid() }), { target: 'draft-7' }),
        response: { 401: error, 404: error, 503: error },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const session = await dependencies.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: 'sign-in-required' });
      const userId = session.user.id;
      const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
      const authorize = () =>
        dependencies.runtime.transaction(workspaceId, commonCompatibility, async tx => {
          await lockAuthorization(tx);
          return (await resolveHuman(tx, userId)).membershipId;
        });
      let membershipId: string;
      try {
        membershipId = await authorize();
        if (!(await dependencies.eligible(workspaceId, userId)))
          return reply.code(404).send({ error: 'recommendations-unavailable' });
      } catch (cause) {
        if (cause instanceof AccessDenied) return reply.code(404).send({ error: 'workspace-not-found' });
        if (!(cause instanceof StorageUnavailableError))
          app.log.error({ workspaceId }, 'Recommendation stream authorization failed');
        return reply.code(503).send({ error: 'recommendations-unavailable' });
      }
      if (!dependencies.events.healthy()) return reply.code(503).send({ error: 'recommendation-events-unavailable' });
      const stream = new PassThrough();
      const timers: NodeJS.Timeout[] = [];
      let ended = false;
      function write(chunk: string) {
        if (ended) return;
        stream.write(chunk);
        if (stream.writableLength > 65536) end();
      }
      const send = (event: RecommendationStreamEvent) =>
        write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
      const unsubscribe = dependencies.events.subscribeRecommendations(workspaceId, membershipId, send);
      function end() {
        if (ended) return;
        ended = true;
        for (const timer of timers) clearTimeout(timer);
        unsubscribe();
        streams.delete(end);
        stream.end();
      }
      function recheck() {
        timers.push(
          setTimeout(async () => {
            try {
              const current = await dependencies.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
              if (
                current?.user.id !== userId ||
                (await authorize()) !== membershipId ||
                !(await dependencies.eligible(workspaceId, userId))
              )
                return end();
            } catch {
              app.log.warn({ workspaceId, membershipId }, 'Recommendation stream access could not be rechecked');
              return end();
            }
            if (!ended) recheck();
          }, 30000),
        );
      }
      streams.add(end);
      reply.raw.once('close', end);
      timers.push(
        setInterval(() => write(': keepalive\n\n'), 15000),
        setTimeout(end, 180000),
      );
      recheck();
      write('retry: 2000\n\n');
      send({ kind: 'resync' });
      return reply
        .header('Content-Type', 'text/event-stream; charset=utf-8')
        .header('X-Accel-Buffering', 'no')
        .header('Connection', 'keep-alive')
        .send(stream);
    },
  );
}
