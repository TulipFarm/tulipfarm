import type { AppPublisher } from '@tulipfarm/extensions';
import { z } from 'zod';
import { appNameSchema } from './names.ts';
import { appRouteColumns, appRouteFromRow } from './store/names.ts';

export type AppSiteObject = {
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentType: string;
  readonly bytes: number;
};

/** The object storage bucket that holds released files under `releases/<releaseId>/<path>`. */
export type AppSiteStorage = {
  has(key: string, signal: AbortSignal): Promise<boolean>;
  put(
    key: string,
    body: AsyncIterable<Uint8Array>,
    file: { readonly contentType: string; readonly bytes: number },
    signal: AbortSignal,
  ): Promise<void>;
  get(key: string, signal: AbortSignal): Promise<AppSiteObject | null>;
  delete(key: string, signal: AbortSignal): Promise<void>;
  /** Keys under a prefix, in ascending byte order. */
  list(prefix: string, signal: AbortSignal): AsyncIterable<string>;
};

/** A connection to the platform database, as the application role. */
export type PlatformDatabase = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

export type AppSiteResponse =
  | { readonly kind: 'file'; readonly object: AppSiteObject }
  /** The app is paused, disabled, has no release yet or runs its own server. Serve 503 and never cache it. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'not-found' };

export type HostHeaderPublisher = AppPublisher & {
  /** Answers one request to `<name>.<sitesDomain>`. `path` is the URL path, still percent-encoded. */
  serve(request: { readonly host: string; readonly path: string }, signal: AbortSignal): Promise<AppSiteResponse>;
};

const releaseIdSchema = z.uuid();

function releasePrefix(releaseId: string) {
  return `releases/${releaseIdSchema.parse(releaseId)}/`;
}

/** Path segments a stored key may contain, so a request can never address a key outside its release. */
function safeSegments(path: string) {
  const segments = path.split('/');
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..' && !/[\\\0]/.test(segment))
    ? segments
    : null;
}

function requestKey(releaseId: string, path: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/')) return null;
  const file = decoded.endsWith('/') ? `${decoded.slice(1)}index.html` : decoded.slice(1);
  return safeSegments(file) ? `releases/${releaseId}/${file}` : null;
}

const listPage = 500;

/**
 * The built-in publisher for self-hosting: released files live in the operator's bucket and the API answers
 * requests whose Host is `<name>.<sitesDomain>`. Routes are the edge columns of `app.app_hostnames`, so only
 * claimed names can be routed and a retired name serves 404. It reports no traffic.
 */
export function hostHeaderPublisher(options: {
  readonly sitesDomain: string;
  readonly storage: AppSiteStorage;
  readonly database: PlatformDatabase;
}): HostHeaderPublisher {
  const { storage, database } = options;
  const sitesDomain = options.sitesDomain.toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!sitesDomain.includes('.')) throw new Error('The app sites domain must be a domain such as sites.example.com');

  return {
    async stage({ releaseId, files, read }, signal) {
      const prefix = releasePrefix(releaseId);
      for (const file of files) {
        signal.throwIfAborted();
        if (!safeSegments(file.path)) throw new Error(`Release file path is not a relative path: ${file.path}`);
        const key = prefix + file.path;
        if (await storage.has(key, signal)) continue;
        await storage.put(key, read(file), { contentType: file.contentType, bytes: file.bytes }, signal);
      }
    },

    async apply(next) {
      const written = await database.query(
        `UPDATE app.app_hostnames SET kind = $2, release_id = $3, status = $4, edge_version = $5
         WHERE name = $1 AND edge_version < $5
         RETURNING ${appRouteColumns}`,
        [next.name, next.kind, next.kind === 'static' ? next.releaseId : null, next.status, next.version],
      );
      // A separate statement takes a fresh snapshot, so a lost race reads the winner's route.
      const { rows } = written.rows.length
        ? written
        : await database.query(`SELECT ${appRouteColumns} FROM app.app_hostnames WHERE name = $1`, [next.name]);
      return { stored: rows[0] === undefined ? null : appRouteFromRow(rows[0]) };
    },

    async remove({ name, version }) {
      await database.query(
        `UPDATE app.app_hostnames SET release_id = NULL, status = NULL, edge_version = $2
         WHERE name = $1 AND edge_version < $2`,
        [name, version],
      );
    },

    async discard({ releaseId }, signal) {
      const prefix = releasePrefix(releaseId);
      const { rows } = await database.query(
        'SELECT 1 FROM app.app_hostnames WHERE release_id = $1 AND status IS NOT NULL LIMIT 1',
        [releaseId],
      );
      if (rows.length) return;
      const keys: string[] = [];
      for await (const key of storage.list(prefix, signal)) keys.push(key);
      for (const key of keys) await storage.delete(key, signal);
    },

    async *list(signal) {
      let after = '';
      for (;;) {
        signal.throwIfAborted();
        const { rows } = await database.query(
          `SELECT ${appRouteColumns} FROM app.app_hostnames
           WHERE status IS NOT NULL AND name > $1 ORDER BY name LIMIT ${listPage}`,
          [after],
        );
        for (const row of rows) yield appRouteFromRow(row)!;
        if (rows.length < listPage) return;
        after = appRouteFromRow(rows.at(-1))!.name;
      }
    },

    async *releases(signal) {
      let previous: string | undefined;
      for await (const key of storage.list('releases/', signal)) {
        const releaseId = key.split('/')[1];
        if (!releaseId || releaseId === previous) continue;
        previous = releaseId;
        yield { releaseId };
      }
    },

    async *usage() {},

    async serve(request, signal) {
      const host = request.host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
      if (!host.endsWith(`.${sitesDomain}`)) return { kind: 'not-found' };
      const name = appNameSchema.safeParse(host.slice(0, -sitesDomain.length - 1));
      if (!name.success) return { kind: 'not-found' };
      const { rows } = await database.query(
        `SELECT ${appRouteColumns} FROM app.app_hostnames WHERE name = $1 AND state = 'current'`,
        [name.data],
      );
      const current = rows[0] === undefined ? null : appRouteFromRow(rows[0]);
      if (!current) return { kind: 'not-found' };
      // Server apps are reached through the gateway, which this publisher does not run.
      if (current.status !== 'active' || current.kind !== 'static' || !current.releaseId)
        return { kind: 'unavailable' };
      const key = requestKey(current.releaseId, request.path);
      const object = key && (await storage.get(key, signal));
      return object ? { kind: 'file', object } : { kind: 'not-found' };
    },
  };
}
