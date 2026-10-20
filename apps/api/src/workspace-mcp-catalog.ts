import { createHash } from 'node:crypto';
import { createBackgroundJob } from '@tulipfarm/observability';
import type { FastifyInstance } from 'fastify';
import { createRegistryCatalog, McpNetworkError } from '@tulipfarm/workspace-mcp-transport';
import { McpHttpError } from './workspace-mcp-http.ts';
import { publicMcpSnapshotSchema, type workspaceMcpCatalogCache } from './workspace-mcp-catalog-cache.ts';
import { z } from 'zod';

export function workspaceMcpCatalog(
  catalog = createRegistryCatalog(),
  cache?: ReturnType<typeof workspaceMcpCatalogCache>,
) {
  let restored: z.infer<typeof publicMcpSnapshotSchema> | null = null;
  let loaded: Promise<void> | undefined;
  const load = () =>
    (loaded ??= (async () => {
      restored = (await cache?.read()) ?? null;
    })().catch(() => undefined));
  return {
    load,
    async refresh() {
      await load();
      await catalog.refreshIfDue();
      const snapshot = catalog.snapshot();
      if (snapshot.syncedAt && !snapshot.refreshFailed && !snapshot.refreshInProgress) {
        const publicSnapshot = publicMcpSnapshotSchema.parse({
          policyVersion: 'latest-usable-v1',
          syncedAt: snapshot.syncedAt,
          entries: snapshot.entries.map(
            ({ id, name, title, description, version, endpoint, status, compatibility, authentication }) => ({
              id,
              name,
              title,
              description,
              version,
              endpoint,
              status,
              compatibility,
              authentication,
            }),
          ),
        });
        if (!restored || publicSnapshot.syncedAt > restored.syncedAt) {
          await cache?.publish(publicSnapshot);
          restored = publicSnapshot;
        }
      }
      return {
        refreshFailed: snapshot.refreshFailed,
        failureCode: snapshot.failureCode,
        failureStage: snapshot.failureStage,
        failureDiagnostics: snapshot.failureDiagnostics,
        refreshInProgress: snapshot.refreshInProgress,
        completedPages: snapshot.completedPages,
      };
    },
    search(search: string, cursor?: string) {
      const live = catalog.snapshot();
      const snapshot =
        restored && (!live.syncedAt || restored.syncedAt > live.syncedAt) ? { ...restored, stale: true } : live;
      const publicEntries = snapshot.entries.map(
        ({ id, name, title, description, version, endpoint, status, compatibility, authentication }) => ({
          id,
          name,
          title,
          description,
          version,
          endpoint,
          status,
          compatibility,
          authentication,
        }),
      );
      const snapshotVersion = createHash('sha256')
        .update(JSON.stringify([snapshot.syncedAt, publicEntries]))
        .digest('hex');
      let offset = 0;
      if (cursor) {
        const [revision, query, index, extra] = cursor.split('.');
        const queryDigest = createHash('sha256').update(search).digest('hex').slice(0, 16);
        if (
          revision !== snapshotVersion ||
          query !== queryDigest ||
          !index ||
          !/^\d{1,8}$/.test(index) ||
          extra !== undefined
        )
          throw new McpHttpError('mcp-catalog-changed', 409);
        offset = Number(index);
      }
      const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const matches = snapshot.entries
        .filter(entry =>
          words.every(word => `${entry.name} ${entry.title} ${entry.description}`.toLowerCase().includes(word)),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      if (offset > matches.length) throw new McpHttpError('invalid-request', 400);
      const entries = matches.slice(offset, offset + 50).map(entry => ({
        id: entry.id,
        name: entry.title,
        description: entry.description,
        version: entry.version,
        endpoint: entry.endpoint,
        compatibility: entry.status === 'deprecated' ? ('unsupported' as const) : ('unknown' as const),
        reason:
          entry.status === 'deprecated'
            ? 'Registry listing is deprecated.'
            : entry.compatibility === 'template-required'
              ? 'Resolve endpoint template values before connecting.'
              : 'Compatibility and authentication have not been verified.',
        authentication: entry.authentication === 'headers-required' ? ('headers' as const) : ('unknown' as const),
      }));
      const nextCursor =
        offset + entries.length < matches.length
          ? `${snapshotVersion}.${createHash('sha256').update(search).digest('hex').slice(0, 16)}.${offset + entries.length}`
          : null;
      return {
        source: 'Official MCP Registry' as const,
        snapshotVersion,
        syncedAt: snapshot.syncedAt,
        stale: snapshot.stale,
        entries,
        nextCursor,
      };
    },
  };
}

export function registerWorkspaceMcpCatalogRefresh(
  app: FastifyInstance,
  catalog: ReturnType<typeof workspaceMcpCatalog>,
) {
  const refreshJob = createBackgroundJob('mcp-catalog-refresh', 900);
  let pending: Promise<void> | undefined;
  let continuation: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let fastRetries = 0;
  const fastRetryDelays = [5000, 15000];
  const schedule = (delay: number) => {
    if (stopping) return;
    continuation = setTimeout(() => {
      continuation = undefined;
      tick();
    }, delay);
    continuation.unref();
  };
  const tick = () => {
    if (pending || stopping || continuation) return;
    pending = refreshJob
      .run(async () => {
        const result = await catalog.refresh();
        if (!result.refreshInProgress) fastRetries = 0;
        if (result.refreshFailed) {
          const retryable =
            result.failureCode === 'catalog-timeout' ||
            result.failureCode === 'network-failed' ||
            (result.failureCode === 'catalog-http' &&
              [500, 502, 503, 504].includes(result.failureDiagnostics?.httpStatus ?? 0));
          const delay = fastRetryDelays[fastRetries];
          if (result.refreshInProgress && retryable && delay !== undefined) {
            fastRetries++;
            schedule(delay);
          }
          throw Object.assign(new McpNetworkError(result.failureCode ?? 'catalog-failed'), {
            stage: result.failureStage,
            catalogDiagnostics: result.failureDiagnostics,
          });
        }
        if (result.refreshInProgress) {
          app.log.info(
            { catalogStatus: 'in-progress', completedPages: result.completedPages },
            'Workspace MCP catalog refresh continuing',
          );
          schedule(1000);
        }
      })
      .catch(() => {
        app.log.warn('Workspace MCP catalog refresh failed');
      })
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref();
  app.addHook('onReady', async () => {
    await catalog.load().catch(() => {
      app.log.warn('Workspace MCP catalog cache unavailable');
    });
    tick();
  });
  app.addHook('onClose', async () => {
    stopping = true;
    clearInterval(timer);
    clearTimeout(continuation);
    await pending;
    refreshJob.close();
  });
}
