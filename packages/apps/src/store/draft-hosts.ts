import type { AppFailure } from '../app.ts';
import type { AppBuildId, AppId } from '../ids.ts';
import { rows, table, type AppTransaction } from './sql.ts';

/**
 * Where the host that runs an app's unpublished draft is. Each app has one draft, so it has at most one draft host.
 * `generation` counts the starts, so a start that lost to a newer one can tell.
 */
export type DraftHost = {
  readonly appId: AppId;
  readonly generation: number;
  readonly buildId: AppBuildId;
  readonly openedAt: string;
} & (
  | { readonly state: 'starting' }
  | { readonly state: 'ready'; readonly hostRef: string }
  | { readonly state: 'failed'; readonly failure: AppFailure }
  | { readonly state: 'stopped' }
);

/** What a draft preview can say about the draft's server. */
export type DraftServer =
  | { readonly state: 'stopped' }
  | { readonly state: 'starting' }
  | { readonly state: 'ready'; readonly hostRef: string }
  | { readonly state: 'failed'; readonly failure: AppFailure };

/** A start that has not recorded a host after this long was lost, and the next request starts again. */
export const draftHostStartMinutes = 10;

type DraftHostRow = {
  app_id: string;
  generation: string;
  build_id: string;
  state: DraftHost['state'];
  host_ref: string | null;
  failure: AppFailure | null;
  opened_at: Date;
};

/** Maps a stored state to what a preview says. */
export function draftServerOf(row: {
  state: DraftHost['state'];
  host_ref: string | null;
  failure: AppFailure | null;
}): DraftServer {
  switch (row.state) {
    case 'ready':
      return { state: 'ready', hostRef: row.host_ref! };
    case 'failed':
      return { state: 'failed', failure: row.failure! };
    default:
      return { state: row.state };
  }
}

const draftHostOf = (row: DraftHostRow): DraftHost => ({
  appId: row.app_id as AppId,
  generation: Number(row.generation),
  buildId: row.build_id as AppBuildId,
  openedAt: row.opened_at.toISOString(),
  ...draftServerOf(row),
});

export async function readDraftHost(tx: AppTransaction, appId: AppId, lock = false): Promise<DraftHost | null> {
  const [row] = await rows<DraftHostRow>(
    tx,
    `SELECT * FROM ${table(tx, 'tf_app_draft_hosts')} WHERE app_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [appId],
  );
  return row ? draftHostOf(row) : null;
}

/**
 * Records that an editor opened the draft preview, and starts a draft host when the draft needs one. A draft needs one
 * when its head commit's newest build is a succeeded server build that is not the live release's build. A host starts
 * again for a new build, after a failure or a stop, and when a start recorded nothing for `draftHostStartMinutes`. A
 * ready host of an older build loses its reference here; reconcile removes it. Returns the generation to start, if any.
 */
export async function requestDraftHost(
  tx: AppTransaction,
  appId: AppId,
): Promise<{ readonly start: { readonly generation: number } | null }> {
  const [head] = await rows<{ build_id: string | null; eligible: boolean }>(
    tx,
    `SELECT h.id AS build_id,
       h.status = 'succeeded' AND h.recipe->>'kind' = 'server' AND a.archived_at IS NULL AND a.disabled_at IS NULL
         AND h.id IS DISTINCT FROM (SELECT r.build_id FROM ${table(tx, 'tf_app_releases')} r
                                    WHERE r.id = a.live_release_id) AS eligible
     FROM ${table(tx, 'tf_apps')} a
     JOIN ${table(tx, 'tf_app_drafts')} d ON d.app_id = a.id
     LEFT JOIN LATERAL (SELECT b.id, b.status, b.recipe FROM ${table(tx, 'tf_app_builds')} b
                        WHERE b.app_id = a.id AND b.commit = d.head_commit
                        ORDER BY b.created_at DESC LIMIT 1) h ON true
     WHERE a.id = $1 FOR UPDATE OF a`,
    [appId],
  );
  if (!head?.eligible || head.build_id === null) return { start: null };
  const [current] = await rows<{ build_id: string; state: DraftHost['state']; lost: boolean }>(
    tx,
    `SELECT build_id, state, updated_at <= clock_timestamp() - make_interval(mins => $2) AS lost
     FROM ${table(tx, 'tf_app_draft_hosts')} WHERE app_id = $1 FOR UPDATE`,
    [appId, draftHostStartMinutes],
  );
  const keep =
    current?.build_id === head.build_id &&
    (current.state === 'ready' || (current.state === 'starting' && !current.lost));
  if (keep) {
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_app_draft_hosts')} SET opened_at = clock_timestamp() WHERE app_id = $1`,
      [appId],
    );
    return { start: null };
  }
  const [started] = await rows<{ generation: string }>(
    tx,
    `INSERT INTO ${table(tx, 'tf_app_draft_hosts')} AS h (app_id, generation, build_id, state, opened_at)
     VALUES ($1, 1, $2, 'starting', clock_timestamp())
     ON CONFLICT (app_id) DO UPDATE SET generation = h.generation + 1, build_id = EXCLUDED.build_id,
       state = 'starting', host_ref = NULL, failure = NULL, opened_at = clock_timestamp(),
       updated_at = clock_timestamp()
     RETURNING generation`,
    [appId, head.build_id],
  );
  return { start: { generation: Number(started!.generation) } };
}

/**
 * Records the host a start brought up. A start that a newer one replaced, or that already failed, gets its host back
 * to remove.
 */
export async function recordDraftHost(
  tx: AppTransaction,
  appId: AppId,
  generation: number,
  hostRef: string,
): Promise<{ readonly retiredHostRef: string | null }> {
  const recorded = await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_draft_hosts')} SET state = 'ready', host_ref = $3, updated_at = clock_timestamp()
     WHERE app_id = $1 AND generation = $2 AND state = 'starting'`,
    [appId, generation, hostRef],
  );
  return { retiredHostRef: recorded.rowCount === 1 ? null : hostRef };
}

/** Ends a start that could not bring up its host. A start that a newer one replaced changes nothing. */
export async function failDraftHost(
  tx: AppTransaction,
  appId: AppId,
  generation: number,
  failure: AppFailure,
): Promise<{ readonly failed: boolean }> {
  const result = await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_draft_hosts')} SET state = 'failed', failure = $3, updated_at = clock_timestamp()
     WHERE app_id = $1 AND generation = $2 AND state = 'starting'`,
    [appId, generation, JSON.stringify(failure)],
  );
  return { failed: result.rowCount === 1 };
}

/** Stops a ready draft host while it still names `hostRef`, so it can be removed. Returns whether it did. */
export async function stopDraftHost(
  tx: AppTransaction,
  appId: AppId,
  hostRef: string,
): Promise<{ readonly stopped: boolean }> {
  const result = await tx.client.query(
    `UPDATE ${table(tx, 'tf_app_draft_hosts')} SET state = 'stopped', host_ref = NULL, updated_at = clock_timestamp()
     WHERE app_id = $1 AND state = 'ready' AND host_ref = $2`,
    [appId, hostRef],
  );
  return { stopped: result.rowCount === 1 };
}
