import { z } from 'zod';
import { boundedJson } from '@tulipfarm/provider-mcp';
import { McpNetworkError, normalizeEndpoint, type McpNetworkErrorCode } from './policy.ts';
import { publicHttpsFetch } from './public-https.ts';

const maximumRemotes = 64;
const headerSchema = z.object({
  name: z.string().max(64),
  description: z.string().max(4096).optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  value: z.string().max(8192).optional(),
});
const serverSchema = z.object({
  server: z.object({
    name: z.string().min(1).max(512),
    version: z.string().min(1).max(256),
    description: z.string().max(16384),
    title: z.string().max(512).optional(),
    remotes: z
      .array(
        z.object({ type: z.string(), url: z.string().max(4096), headers: z.array(headerSchema).max(16).optional() }),
      )
      .max(maximumRemotes)
      .optional(),
  }),
  _meta: z.object({
    'io.modelcontextprotocol.registry/official': z.object({
      status: z.enum(['active', 'deprecated', 'deleted']),
      updatedAt: z.string(),
      publishedAt: z.string().optional(),
      isLatest: z.literal(true),
    }),
  }),
});
const pageSchema = z.object({
  servers: z.array(serverSchema).max(100),
  metadata: z.object({ nextCursor: z.string().max(4096).nullish(), count: z.number().int().nonnegative().optional() }),
});
const maximumPageBytes = 2 * 1024 * 1024;
// Reserve space for the policy and timestamp envelope in the 64 MiB public cache.
const maximumSnapshotBytes = 64 * 1024 * 1024 - 1024;
const maximumEntries = 100000;
const maximumRequests = 2000;

export type RegistryEntry = {
  id: string;
  name: string;
  version: string;
  title: string;
  description: string;
  endpoint: string;
  status: 'active' | 'deprecated';
  compatibility: 'unverified' | 'template-required';
  authentication: 'unknown' | 'headers-required';
};
export type RegistryFailureStage =
  | 'catalog-fetch'
  | 'catalog-read'
  | 'catalog-parse'
  | 'catalog-validate'
  | 'catalog-page';
export type RegistryFailureDiagnostics = {
  httpStatus?: number;
  pageBytes: number;
  receivedBytes: number;
  completedPages: number;
  attempts: number;
};
export type RegistrySnapshot = {
  entries: readonly RegistryEntry[];
  syncedAt: string | null;
  stale: boolean;
  refreshFailed: boolean;
  failureCode?: McpNetworkErrorCode;
  failureStage?: RegistryFailureStage;
  failureDiagnostics?: RegistryFailureDiagnostics;
  refreshInProgress: boolean;
  completedPages: number;
};

export function createRegistryCatalog({
  fetcher = publicHttpsFetch,
  now = () => new Date(),
  elapsedNow = () => performance.now(),
}: { fetcher?: typeof fetch; now?: () => Date; elapsedNow?: () => number } = {}) {
  let entries = new Map<string, RegistryEntry>();
  let syncedAt: string | null = null;
  let refreshFailed = false;
  let failureCode: McpNetworkErrorCode | undefined;
  let failureStage: RegistryFailureStage | undefined;
  let failureDiagnostics: RegistryFailureDiagnostics | undefined;
  let pending: Promise<RegistrySnapshot> | null = null;
  let scan: {
    startedAt: string;
    next: Map<string, RegistryEntry>;
    versions: Map<string, string>;
    cursors: Set<string>;
    cursor: string | undefined;
    bytes: number;
    nextBytes: number;
    attempts: number;
    pages: number;
  } | null = null;

  function snapshot(): RegistrySnapshot {
    return {
      entries: structuredClone([...entries.values()]),
      syncedAt,
      stale: !syncedAt || now().getTime() - Date.parse(syncedAt) >= 21600000 || refreshFailed,
      refreshFailed,
      ...(failureCode ? { failureCode } : {}),
      refreshInProgress: scan !== null,
      ...(failureStage ? { failureStage } : {}),
      ...(failureDiagnostics ? { failureDiagnostics: { ...failureDiagnostics } } : {}),
      completedPages: scan?.pages ?? 0,
    };
  }
  function search(query: string) {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return snapshot().entries.filter(entry =>
      words.every(word => `${entry.name} ${entry.title} ${entry.description}`.toLowerCase().includes(word)),
    );
  }
  async function sync(): Promise<RegistrySnapshot> {
    if (!scan) {
      scan = {
        startedAt: now().toISOString(),
        next: new Map(),
        versions: new Map(),
        cursors: new Set(),
        cursor: undefined,
        bytes: 0,
        nextBytes: 2,
        attempts: 0,
        pages: 0,
      };
    }
    const current = scan;
    const chunkStarted = elapsedNow();
    let chunkPages = 0;
    let stage: McpNetworkErrorCode = 'network-failed';
    let phase: RegistryFailureStage = 'catalog-page';
    let httpStatus: number | undefined;
    let pageBytes = 0;
    const signal = AbortSignal.timeout(60000);
    try {
      do {
        phase = 'catalog-page';
        httpStatus = undefined;
        pageBytes = 0;
        if (++current.attempts > maximumRequests) throw new McpNetworkError('catalog-page-limit');
        const url = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
        url.searchParams.set('limit', '100');
        url.searchParams.set('version', 'latest');
        if (current.cursor) url.searchParams.set('cursor', current.cursor);
        stage = 'network-failed';
        phase = 'catalog-fetch';
        const response = await fetcher(url, { signal, redirect: 'error', headers: { accept: 'application/json' } });
        httpStatus = response.status;
        if (!response.ok) {
          await response.body?.cancel();
          throw new McpNetworkError('catalog-http');
        }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
          await response.body?.cancel();
          throw new McpNetworkError('catalog-response');
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        phase = 'catalog-read';
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            current.bytes += chunk.value.length;
            pageBytes += chunk.value.length;
            if (pageBytes > maximumPageBytes) throw new McpNetworkError('catalog-byte-limit');
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        stage = 'catalog-invalid-json';
        phase = 'catalog-parse';
        const parsed = boundedJson(JSON.parse(Buffer.concat(chunks).toString('utf8')), maximumPageBytes);
        stage = 'catalog-invalid-schema';
        phase = 'catalog-validate';
        const page = pageSchema.parse(parsed);
        const cursor = page.metadata.nextCursor ?? undefined;
        if (cursor !== undefined && (!cursor || current.cursors.has(cursor)))
          throw new McpNetworkError('catalog-cursor-loop');
        for (const record of page.servers) {
          const official = record._meta['io.modelcontextprotocol.registry/official'];
          if (
            !Number.isFinite(Date.parse(official.updatedAt)) ||
            (official.publishedAt !== undefined && !Number.isFinite(Date.parse(official.publishedAt)))
          ) {
            throw new McpNetworkError('catalog-invalid-timestamp');
          }
        }
        const next = current.next;
        phase = 'catalog-page';
        for (const record of page.servers) {
          const official = record._meta['io.modelcontextprotocol.registry/official'];
          const previousVersion = current.versions.get(record.server.name);
          if (previousVersion !== undefined && previousVersion !== record.server.version) {
            throw new McpNetworkError('catalog-invalid-schema');
          }
          if (previousVersion === undefined && current.versions.size >= maximumEntries)
            throw new McpNetworkError('catalog-entry-limit');
          current.versions.set(record.server.name, record.server.version);
          const prefix = `${record.server.name}@${record.server.version}:`;
          for (let index = 0; index < maximumRemotes; index++) {
            const id = `${prefix}${index}`;
            const previous = next.get(id);
            if (!previous) continue;
            current.nextBytes -= Buffer.byteLength(JSON.stringify(previous)) + (next.size > 1 ? 1 : 0);
            next.delete(id);
          }
          if (official.status === 'deleted') continue;
          for (const [index, remote] of (record.server.remotes ?? []).entries()) {
            if (remote.type !== 'streamable-http') continue;
            const template = /\{[^{}]+\}/.test(remote.url);
            try {
              normalizeEndpoint(template ? remote.url.replace(/\{[^{}]+\}/g, 'template') : remote.url);
            } catch {
              continue;
            }
            const id = `${prefix}${index}`;
            const entry: RegistryEntry = {
              id,
              name: record.server.name,
              version: record.server.version,
              title: record.server.title ?? record.server.name,
              description: record.server.description,
              endpoint: remote.url,
              status: official.status,
              compatibility: template ? 'template-required' : 'unverified',
              authentication: remote.headers?.some(header => header.isRequired) ? 'headers-required' : 'unknown',
            };
            if (next.size >= maximumEntries) throw new McpNetworkError('catalog-entry-limit');
            const bytes = Buffer.byteLength(JSON.stringify(entry)) + (next.size ? 1 : 0);
            if (current.nextBytes + bytes > maximumSnapshotBytes) throw new McpNetworkError('catalog-byte-limit');
            next.set(id, entry);
            current.nextBytes += bytes;
          }
        }
        current.cursor = cursor;
        current.pages++;
        if (cursor !== undefined) current.cursors.add(cursor);
        refreshFailed = false;
        failureCode = undefined;
        failureStage = undefined;
        failureDiagnostics = undefined;
        if (cursor && (++chunkPages >= 25 || elapsedNow() - chunkStarted >= 45000)) return snapshot();
      } while (current.cursor);
      entries = current.next;
      syncedAt = current.startedAt;
      scan = null;
    } catch (error) {
      refreshFailed = true;
      failureCode = signal.aborted ? 'catalog-timeout' : error instanceof McpNetworkError ? error.code : stage;
      failureStage = phase;
      failureDiagnostics = {
        ...(httpStatus === undefined ? {} : { httpStatus }),
        pageBytes,
        receivedBytes: current.bytes,
        completedPages: current.pages,
        attempts: current.attempts,
      };
      if (!['catalog-timeout', 'network-failed', 'catalog-http'].includes(failureCode)) scan = null;
    }
    return snapshot();
  }
  function refresh(): Promise<RegistrySnapshot> {
    if (pending) return pending;
    pending = sync().finally(() => {
      pending = null;
    });
    return pending;
  }
  async function refreshIfDue() {
    return scan || snapshot().stale ? refresh() : snapshot();
  }
  return { snapshot, search, refresh, refreshIfDue };
}

export function resolveRegistryEndpoint(template: string, values: Readonly<Record<string, string>>): string {
  const resolved = template.replace(/\{([^{}]+)\}/g, (_match: string, name: string) => {
    const value = values[name];
    if (!value || value.length > 512 || !/^[A-Za-z0-9._~-]+$/.test(value)) throw new McpNetworkError('endpoint-denied');
    return value;
  });
  return normalizeEndpoint(resolved);
}
