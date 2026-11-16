import { createHash } from 'node:crypto';
import { z } from 'zod';
import { appIdSchema, releaseIdSchema, type AppId, type AppReleaseId } from '../ids.ts';
import {
  signRequestHandle,
  type RequestHandle,
  type RequestHandleKey,
  type SignedRequestHandle,
} from './request-handles.ts';
import type { SqlClient } from './sql.ts';

export const liveRequestSeconds = 60;

/** The app and release serving a visitor request. */
export type LiveAppRequest = {
  readonly workspaceId: string;
  readonly appId: AppId;
  readonly releaseId: AppReleaseId;
};

const liveRequestRowSchema = z
  .object({ workspace_id: z.uuid(), app_id: appIdSchema, release_id: releaseIdSchema })
  .transform(row => ({ workspaceId: row.workspace_id, appId: row.app_id, releaseId: row.release_id }));

const digest = (handle: RequestHandle) => createHash('sha256').update(handle).digest();

/** Opens a request for `liveRequestSeconds`. The handle is returned once; only its digest is stored. */
export async function mintRequestHandle(
  platform: SqlClient,
  key: RequestHandleKey,
  request: LiveAppRequest,
): Promise<{ readonly handle: RequestHandle }> {
  const handle = signRequestHandle(key, request.appId);
  await platform.query(
    `INSERT INTO app.app_live_requests (handle_sha256, workspace_id, app_id, release_id, expires_at)
     VALUES ($1, $2, $3, $4, clock_timestamp() + make_interval(secs => $5))`,
    [digest(handle), request.workspaceId, request.appId, request.releaseId, liveRequestSeconds],
  );
  return { handle };
}

/** Keeps an open request live for another `liveRequestSeconds`. Returns false once it has expired or closed. */
export async function renewRequestHandle(platform: SqlClient, handle: RequestHandle): Promise<boolean> {
  const renewed = await platform.query(
    `UPDATE app.app_live_requests SET expires_at = clock_timestamp() + make_interval(secs => $2)
     WHERE handle_sha256 = $1 AND expires_at > clock_timestamp()`,
    [digest(handle), liveRequestSeconds],
  );
  return renewed.rowCount === 1;
}

/** Ends a request. Closing it again does nothing. */
export async function closeRequestHandle(platform: SqlClient, handle: RequestHandle) {
  await platform.query('DELETE FROM app.app_live_requests WHERE handle_sha256 = $1', [digest(handle)]);
}

/** Reads the request a verified handle names, or null when it is unknown, expired or closed. */
export async function resolveRequestHandle(
  platform: SqlClient,
  { handle, appId }: SignedRequestHandle,
): Promise<LiveAppRequest | null> {
  const [row] = (
    await platform.query(
      `SELECT workspace_id, app_id, release_id FROM app.app_live_requests
       WHERE handle_sha256 = $1 AND app_id = $2 AND expires_at > clock_timestamp()`,
      [digest(handle), appId],
    )
  ).rows;
  return row ? liveRequestRowSchema.parse(row) : null;
}

/** Deletes expired requests and returns how many it removed. */
export async function sweepExpiredRequestHandles(platform: SqlClient): Promise<number> {
  return (
    (await platform.query('DELETE FROM app.app_live_requests WHERE expires_at <= clock_timestamp()')).rowCount ?? 0
  );
}
