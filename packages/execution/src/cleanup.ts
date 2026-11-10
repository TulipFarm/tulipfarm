import { z } from 'zod';
import { commonCompatibility, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { executionChunkBytes, removeExecutionObjectChunk, type ExecutionObjectBytes } from './file-bytes.ts';
import { claimIntent, finishIntent } from './outbox.ts';
import {
  advanceObjectCleanup,
  beginObjectCleanup,
  finishObjectCleanup,
  objectIsRetained,
  readObject,
  type RetainedObject,
} from './uploads.ts';
import { ExecutionConflict, table, type ExecutionTransaction } from './state.ts';

export function createExecutionCleanup(
  runtime: Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>,
  objects: ExecutionObjectBytes,
) {
  return {
    async process(workspaceId: string, operation: { leaseSeconds: number; signal: AbortSignal }) {
      z.uuid().parse(workspaceId);
      const { signal, leaseSeconds } = operation;
      signal.throwIfAborted();
      const transaction = <T>(run: (tx: ExecutionTransaction) => Promise<T>) =>
        runtime.transaction(workspaceId, { ...commonCompatibility, minimum: 42 }, run);
      const candidate = await transaction(tx => claimIntent(tx, leaseSeconds, 'file-cleanup'));
      if (!candidate) return 'idle' as const;
      const claim = candidate;
      if (!claim.object_id) throw new ExecutionConflict('request-conflict');
      const objectId = claim.object_id;
      async function lockClaim(tx: ExecutionTransaction) {
        signal.throwIfAborted();
        await tx.client.query(`SELECT id FROM ${table(tx, 'tf_execution_areas')} WHERE id=$1 FOR UPDATE`, [
          claim.area_id,
        ]);
        const owned = await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_execution_outbox')} WHERE id=$1 AND lease_id=$2
            AND area_id=$3 AND object_id=$4 AND generation=$5 AND operation='file-cleanup'
            AND completed_at IS NULL AND lease_until>clock_timestamp() FOR UPDATE`,
          [claim.id, claim.lease_id, claim.area_id, objectId, claim.generation],
        );
        if (!owned.rowCount) throw new ExecutionConflict('stale');
      }
      const prepared = await transaction<{ state: 'deleted' | 'retained' | 'pending' } | { object: RetainedObject }>(
        async tx => {
          await lockClaim(tx);
          const object = await readObject(tx, claim.area_id, objectId);
          if (object.state === 'deleted') {
            await finishIntent(tx, claim);
            return { state: 'deleted' as const };
          }
          if (await objectIsRetained(tx, object.id)) {
            await finishIntent(tx, claim);
            return { state: 'retained' as const };
          }
          if (!(await beginObjectCleanup(tx, claim.area_id, objectId))) {
            await finishIntent(tx, claim, 1);
            return { state: 'pending' as const };
          }
          if (object.retired_chunks === Math.ceil(object.size / executionChunkBytes)) {
            await finishObjectCleanup(tx, claim.area_id, objectId);
            await finishIntent(tx, claim);
            return { state: 'deleted' as const };
          }
          return { object };
        },
      );
      if ('state' in prepared) return prepared.state;
      const { object } = prepared;
      await removeExecutionObjectChunk(
        objects,
        { workspaceId, areaId: claim.area_id, objectId, size: object.size, sha256: object.sha256 },
        object.retired_chunks,
        signal,
      );
      return transaction(async tx => {
        await lockClaim(tx);
        await advanceObjectCleanup(tx, claim.area_id, objectId, object.retired_chunks);
        if (object.retired_chunks + 1 === Math.ceil(object.size / executionChunkBytes)) {
          await finishObjectCleanup(tx, claim.area_id, objectId);
          await finishIntent(tx, claim);
          return 'deleted' as const;
        }
        await finishIntent(tx, claim, 1);
        return 'pending' as const;
      });
    },
  };
}
