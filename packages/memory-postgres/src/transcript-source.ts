import type { TranscriptSource } from '@tulipfarm/memory-core/ports/transcript-source';
import { memoryTable, type PostgresMemoryNames } from './names.ts';
import type { MemoryQueryClient } from './query-client.ts';

export function createPostgresTranscriptSource(
  client: MemoryQueryClient,
  names: PostgresMemoryNames,
): TranscriptSource {
  const table = (name: string) => memoryTable(names, name);
  return {
    requesterMessages: values =>
      client.query(
        `SELECT m.id,m.created_at::text AS "createdAt",t.accepted_sequence AS "acceptedSequence",string_agg(p.text,E'\n' ORDER BY p.ordinal) AS text
      FROM ${table('conversation_messages')} m JOIN ${table('conversation_parts')} p ON p.message_id=m.id AND p.kind IN ('text','layout')
      JOIN ${table('conversation_turns')} t ON t.source_message_id=m.id
      WHERE m.conversation_id=$1 AND m.author_kind='human' AND m.membership_id=$2 AND t.accepted_sequence<=$3
        AND t.accepted_sequence>COALESCE((SELECT max(covered_through) FROM ${table('conversation_maintenance')}
          WHERE conversation_id=$1 AND generation<$5 AND memory_complete),0)
        AND ($4::timestamptz IS NULL OR m.created_at>$4) AND NOT EXISTS (
          SELECT 1 FROM ${table('internal_publications')} i WHERE i.message_id=m.id)
      GROUP BY m.id,m.sequence,t.accepted_sequence ORDER BY m.sequence`,
        values,
      ),
  };
}
