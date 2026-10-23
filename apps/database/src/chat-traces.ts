import { workspaceIdSchema, workspaceNames, type SqlClient } from '@tulipfarm/workspace-storage/provisioning';
import { DatabaseError } from './config.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A chat id from a bare id or a chat URL such as `https://app.example.com/<workspace-slug>/chat/<chat-id>`. */
export function chatIdFromInput(value: string): string {
  const trimmed = value.trim();
  if (uuid.test(trimmed)) return trimmed.toLowerCase();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DatabaseError('Pass a chat URL or chat id.');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const chat = segments.lastIndexOf('chat');
  const id = chat >= 0 ? segments[chat + 1] : undefined;
  if (!id || !uuid.test(id)) throw new DatabaseError('The URL has no /chat/<chat-id> segment.');
  return id.toLowerCase();
}

export type ChatTurnTrace = {
  turnId: string;
  sequence: number;
  status: string;
  attempts: number;
  errorCode: string | null;
  startedAt: string | null;
  claimedAt: string | null;
  finishedAt: string | null;
  traceId: string | null;
  traceSampled: boolean | null;
};

/**
 * Finds a chat's turns and the trace each reply's latest attempt ran under. Reads ids, states and times only, never
 * message content. It needs the workspace provisioning login, which owns every workspace schema; runtime and
 * application logins cannot read other workspaces, so they are refused by PostgreSQL.
 */
export async function chatTraces(
  client: SqlClient,
  chatId: string,
  workspaceIds: readonly string[],
): Promise<{ workspaceId: string; chatId: string; turns: ChatTurnTrace[] } | undefined> {
  for (const workspaceId of workspaceIds) {
    const { schema } = workspaceNames(workspaceIdSchema.parse(workspaceId));
    const conversations = `"${schema}".tf_conversations`;
    const turns = `"${schema}".tf_conversation_turns`;
    const found = await client.query(`SELECT 1 FROM ${conversations} WHERE id = $1`, [chatId]);
    if (!found.rowCount) continue;
    // to_jsonb reads the trace columns on workspaces still waiting for common migration 0002.
    const rows = await client.query(
      `SELECT t.id AS "turnId", t.accepted_sequence AS sequence, t.status, t.attempts, t.error_code AS "errorCode",
        t.timing_started_at AS "startedAt", t.timing_claimed_at AS "claimedAt", t.timing_finished_at AS "finishedAt",
        to_jsonb(t)->>'trace_id' AS "traceId", (to_jsonb(t)->>'trace_sampled')::boolean AS "traceSampled"
      FROM ${turns} t WHERE t.conversation_id = $1 ORDER BY t.accepted_sequence`,
      [chatId],
    );
    return {
      workspaceId,
      chatId,
      turns: rows.rows.map(row => ({
        ...row,
        startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
        claimedAt: row.claimedAt ? new Date(row.claimedAt).toISOString() : null,
        finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
      })) as ChatTurnTrace[],
    };
  }
  return undefined;
}
