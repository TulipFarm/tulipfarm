import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import type { AppBuildId, AppId, MembershipId } from '../ids.ts';
import { appRole } from './grants.ts';
import type { AppSourceStorage } from './repository.ts';
import { failed, rows, table, type AppResult, type AppTransaction, type SqlClient } from './sql.ts';

export const previewTicketSeconds = 60;
export const previewSessionSeconds = 12 * 60 * 60;

/** The random label of an app's preview host, as `createApp` makes it. */
export const previewKeyPattern = /^[a-z2-7]{26}$/;

export type PreviewHost = { readonly previewKey: string; readonly workspaceId: string; readonly appId: AppId };

/** Who a redeemed preview cookie speaks for. Access is checked again on every request. */
export type PreviewSession = {
  readonly workspaceId: string;
  readonly appId: AppId;
  readonly membershipId: MembershipId;
};

const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
const secret = () => randomBytes(32).toString('base64url');

/**
 * Records which workspace app a preview host serves, so the gateway resolves a host without scanning workspace
 * schemas. Registering the same host again is a no-op; a key bound to another app is a bug and throws.
 */
export async function registerPreviewHost(platform: SqlClient, host: PreviewHost) {
  await platform.query(
    `INSERT INTO app.app_preview_hosts (preview_key, workspace_id, app_id) VALUES ($1, $2, $3)
     ON CONFLICT (preview_key) DO NOTHING`,
    [host.previewKey, host.workspaceId, host.appId],
  );
  const [row] = (
    await platform.query<{ workspace_id: string; app_id: string }>(
      'SELECT workspace_id, app_id FROM app.app_preview_hosts WHERE preview_key = $1',
      [host.previewKey],
    )
  ).rows;
  if (row?.workspace_id !== host.workspaceId || row.app_id !== host.appId)
    throw new Error(`Draft host ${host.previewKey} belongs to another app`);
}

/**
 * Checks that a signed-in user may preview an app and returns the membership and host a ticket is issued for. Only
 * editors preview, and only public apps have a preview host.
 */
export async function admitPreview(
  tx: AppTransaction,
  appId: AppId,
  userId: string,
): Promise<AppResult<{ readonly membershipId: MembershipId; readonly previewKey: string }>> {
  const [member] = await rows<{ id: MembershipId }>(
    tx,
    `SELECT id FROM ${table(tx, 'tf_memberships')} WHERE user_id = $1 AND removed_at IS NULL`,
    [userId],
  );
  if (!member) return failed('not-found', 'App not found');
  const [app] = await rows<{ preview_key: string | null }>(
    tx,
    `SELECT preview_key FROM ${table(tx, 'tf_apps')} WHERE id = $1 AND archived_at IS NULL`,
    [appId],
  );
  const role = app ? await appRole(tx, appId, member.id) : null;
  if (!app || !role) return failed('not-found', 'App not found');
  if (role !== 'edit') return failed('forbidden', 'Only editors can open the draft of this app');
  if (app.preview_key === null) return failed('not-found', 'This app has no draft host');
  return { ok: true, membershipId: member.id, previewKey: app.preview_key };
}

/**
 * Issues a one-time ticket that opens a preview session on one host within `previewTicketSeconds`. The session it
 * opens belongs to the sign-in session that asked for it. Expired rows of that sign-in session are removed here.
 */
export async function issuePreviewTicket(
  platform: SqlClient,
  input: { readonly previewKey: string; readonly authSessionId: string; readonly membershipId: MembershipId },
): Promise<{ readonly ticket: string }> {
  await platform.query(
    `DELETE FROM app.app_preview_sessions WHERE auth_session_id = $1
       AND (expires_at <= clock_timestamp() OR (redeemed_at IS NULL AND ticket_expires_at <= clock_timestamp()))`,
    [input.authSessionId],
  );
  const ticket = secret();
  await platform.query(
    `INSERT INTO app.app_preview_sessions
       (id, preview_key, auth_session_id, membership_id, ticket_sha256, ticket_expires_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp() + make_interval(secs => $6),
       clock_timestamp() + make_interval(secs => $7))`,
    [
      randomUUID(),
      input.previewKey,
      input.authSessionId,
      input.membershipId,
      digest(ticket),
      previewTicketSeconds,
      previewSessionSeconds,
    ],
  );
  return { ticket };
}

/**
 * Redeems a ticket on the host it was issued for and returns the session cookie value. A ticket redeems once; a
 * second, late or wrong-host redemption returns null.
 */
export async function redeemPreviewTicket(
  platform: SqlClient,
  previewKey: string,
  ticket: string,
): Promise<{ readonly token: string } | null> {
  const token = secret();
  const redeemed = await platform.query(
    `UPDATE app.app_preview_sessions SET token_sha256 = $3, redeemed_at = clock_timestamp()
     WHERE ticket_sha256 = $1 AND preview_key = $2 AND redeemed_at IS NULL
       AND ticket_expires_at > clock_timestamp()`,
    [digest(ticket), previewKey, digest(token)],
  );
  return redeemed.rowCount === 1 ? { token } : null;
}

/** Reads the live session a preview cookie names on its host. Signing out or expiry ends it. */
export async function readPreviewSession(
  platform: SqlClient,
  previewKey: string,
  token: string,
): Promise<PreviewSession | null> {
  const [row] = (
    await platform.query<{ workspace_id: string; app_id: string; membership_id: string }>(
      `SELECT h.workspace_id, h.app_id, p.membership_id
       FROM app.app_preview_sessions p
       JOIN app.app_preview_hosts h ON h.preview_key = p.preview_key
       JOIN app.sessions s ON s.id = p.auth_session_id
       WHERE p.token_sha256 = $1 AND p.preview_key = $2
         AND p.expires_at > clock_timestamp() AND s.expires_at > clock_timestamp()`,
      [digest(token), previewKey],
    )
  ).rows;
  return row
    ? {
        workspaceId: row.workspace_id,
        appId: row.app_id as AppId,
        membershipId: row.membership_id as MembershipId,
      }
    : null;
}

export type PreviewBuild = { readonly buildId: AppBuildId; readonly manifestKey: string };

/**
 * What a draft preview serves. A draft whose head commit builds a server previews that server, which runs only while
 * a publish of that commit has brought it up as the app's candidate host; `hostRef` is null otherwise. Any other
 * draft previews the files of its previewed build, or nothing before its first build.
 */
export type PreviewTarget =
  | { readonly kind: 'files'; readonly build: PreviewBuild | null }
  | { readonly kind: 'server'; readonly hostRef: string | null };

/**
 * What a preview session may serve right now, while the member is current and still holds `edit` and the app is
 * neither archived nor disabled.
 */
export async function readPreviewTarget(
  tx: AppTransaction,
  session: PreviewSession,
): Promise<AppResult<{ readonly target: PreviewTarget }>> {
  if ((await appRole(tx, session.appId, session.membershipId)) !== 'edit')
    return failed('forbidden', 'Only editors can open the draft of this app');
  const [row] = await rows<{
    id: string | null;
    manifest_key: string | null;
    head_kind: string | null;
    candidate_host_ref: string | null;
  }>(
    tx,
    `SELECT b.id, b.manifest_key,
       (SELECT h.recipe->>'kind' FROM ${table(tx, 'tf_app_builds')} h WHERE h.app_id = a.id AND h.commit = d.head_commit
         ORDER BY h.created_at DESC LIMIT 1) AS head_kind,
       (SELECT r.candidate_host_ref FROM ${table(tx, 'tf_app_runtimes')} r
         JOIN ${table(tx, 'tf_app_releases')} c ON c.id = r.candidate_release_id
         WHERE r.app_id = a.id AND c.commit = d.head_commit) AS candidate_host_ref
     FROM ${table(tx, 'tf_apps')} a
     JOIN ${table(tx, 'tf_app_drafts')} d ON d.app_id = a.id
     LEFT JOIN ${table(tx, 'tf_app_builds')} b ON b.id = d.preview_build_id AND b.status = 'succeeded'
     WHERE a.id = $1 AND a.archived_at IS NULL AND a.disabled_at IS NULL`,
    [session.appId],
  );
  if (!row) return failed('not-found', 'App not found');
  if (row.head_kind === 'server') return { ok: true, target: { kind: 'server', hostRef: row.candidate_host_ref } };
  return {
    ok: true,
    target: {
      kind: 'files',
      build:
        row.id === null || row.manifest_key === null
          ? null
          : { buildId: row.id as AppBuildId, manifestKey: row.manifest_key },
    },
  };
}

/** Streams an object from the apps bucket, such as a build manifest or a file blob, or null when it is missing. */
export async function readAppObject(storage: AppSourceStorage, key: string): Promise<Readable | null> {
  try {
    const object = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
    return (object.Body as Readable | undefined) ?? null;
  } catch (error) {
    if (error instanceof NoSuchKey) return null;
    throw error;
  }
}
