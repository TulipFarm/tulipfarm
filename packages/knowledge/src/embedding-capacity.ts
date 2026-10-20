import { z } from 'zod';
import type { SqlClient } from '@tulipfarm/workspace-storage/provisioning';
import type { KnowledgeEmbeddingCapacity } from './embeddings.ts';
import { Pool } from 'pg';

const claimSchema = z.strictObject({
  workspaceId: z.uuid(),
  purpose: z.enum(['query', 'ingestion']),
  tokens: z.number().int().positive().max(2147483647),
  attemptId: z.uuid(),
  deadlineAt: z.number().finite().optional(),
});
const resultSchema = z.tuple([z.object({ admitted: z.boolean() })]);

export function createKnowledgeEmbeddingCapacity(pool: SqlClient): { acquire: KnowledgeEmbeddingCapacity } {
  return {
    async acquire(input) {
      const claim = claimSchema.parse(input);
      if (claim.deadlineAt !== undefined) {
        const deadlineAt = claim.deadlineAt;
        if (!(pool instanceof Pool)) throw new TypeError('Deadline capacity admission requires a connection pool');
        if (deadlineAt <= Date.now()) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let expired = false;
        let stop = () => {};
        const connection = pool.connect().then(client => {
          if (expired) {
            client.release(true);
            throw new Error('capacity-deadline');
          }
          return client;
        });
        try {
          return await Promise.race([
            (async () => {
              const client = await connection;
              let released = false;
              stop = () => {
                if (!released) {
                  released = true;
                  client.release(true);
                }
              };
              try {
                await client.query(
                  "SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$1,false)",
                  [String(Math.max(1, deadlineAt - Date.now()))],
                );
                const result = await client.query(
                  'SELECT app.acquire_knowledge_embedding_capacity($1::uuid,$2::text,$3::integer,$4::uuid) AS admitted',
                  [claim.workspaceId, claim.purpose, claim.tokens, claim.attemptId],
                );
                const admitted = resultSchema.parse(result.rows)[0].admitted;
                await client.query('RESET statement_timeout; RESET lock_timeout');
                if (!released) {
                  released = true;
                  client.release();
                }
                return admitted;
              } finally {
                stop();
              }
            })(),
            new Promise<boolean>(resolve => {
              timer = setTimeout(
                () => {
                  expired = true;
                  stop();
                  resolve(false);
                },
                Math.max(0, deadlineAt - Date.now()),
              );
            }),
          ]);
        } catch (error) {
          if (
            expired ||
            (error instanceof Error && 'code' in error && (error.code === '57014' || error.code === '55P03'))
          )
            return false;
          throw error;
        } finally {
          clearTimeout(timer);
        }
      }
      const result = await pool.query(
        'SELECT app.acquire_knowledge_embedding_capacity($1::uuid, $2::text, $3::integer, $4::uuid) AS admitted',
        [claim.workspaceId, claim.purpose, claim.tokens, claim.attemptId],
      );
      return resultSchema.parse(result.rows)[0].admitted;
    },
  };
}
