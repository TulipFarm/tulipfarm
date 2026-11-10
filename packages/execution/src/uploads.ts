import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { executionFileSchema, type ExecutionPolicy } from '@tulipfarm/execution-contract';
import { requireGeneration } from './allocations.ts';
import { validateChunks, chunkSchema, executionChunkBytes, type ExecutionChunk } from './file-bytes.ts';
import { ExecutionConflict, table, type ExecutionArea, type ExecutionTransaction } from './state.ts';

const objectSchema = z.object({
  id: z.uuid(),
  area_id: z.uuid(),
  generation: z.number().int().positive(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  state: z.enum(['uploading', 'ready', 'deleting', 'deleted']),
  chunks: z.array(chunkSchema),
  retired_chunks: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sources: z.array(z.unknown()),
});
export type RetainedObject = z.infer<typeof objectSchema>;

export async function readObject(tx: ExecutionTransaction, areaId: string, objectId: string) {
  const object = objectSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT *,size::double precision AS size FROM ${table(tx, 'tf_execution_objects')} WHERE id=$1 AND area_id=$2 FOR UPDATE`,
          [z.uuid().parse(objectId), z.uuid().parse(areaId)],
        )
      ).rows[0],
    );
  if (!object) throw new ExecutionConflict('not-found');
  return object;
}

/** Caller takes lockExecutionStorage before the area lock. In-flight uploads count against the workspace quota. */
export async function reserveUpload(
  tx: ExecutionTransaction,
  area: ExecutionArea,
  fileInput: unknown,
  sources: unknown[],
  limits: ExecutionPolicy['limits'],
) {
  const file = executionFileSchema.parse(fileInput);
  if (file.size > limits.fileBytes) throw new ExecutionConflict('quota');
  await requireGeneration(tx, area.id, area.generation);
  const usage = z
    .object({ bytes: z.string() })
    .parse(
      (
        await tx.client.query(
          `SELECT COALESCE(sum(size),0)::text AS bytes FROM ${table(tx, 'tf_execution_objects')} WHERE state<>'deleted'`,
        )
      ).rows[0],
    );
  if (BigInt(usage.bytes) + BigInt(file.size) > BigInt(limits.workspaceStorageBytes))
    throw new ExecutionConflict('quota');
  const count = z
    .object({ count: z.number().int() })
    .parse(
      (
        await tx.client.query(
          `SELECT count(*)::integer AS count FROM ${table(tx, 'tf_execution_objects')} WHERE area_id=$1 AND state<>'deleted'`,
          [area.id],
        )
      ).rows[0],
    ).count;
  if (count >= limits.fileCount) throw new ExecutionConflict('quota');
  const id = randomUUID();
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_execution_objects')} (id,area_id,generation,size,sha256,sources,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()+($7::double precision*interval '1 second'))`,
    [id, area.id, area.generation, file.size, file.sha256, JSON.stringify(sources), limits.jobTimeoutSeconds],
  );
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_execution_outbox')} (id,area_id,generation,object_id,operation,dedupe_key,available_at)
      SELECT $1,area_id,generation,id,'file-cleanup',id::text||':upload-cleanup',expires_at
      FROM ${table(tx, 'tf_execution_objects')} WHERE id=$2`,
    [randomUUID(), id],
  );
  return { ...file, objectId: id, sources };
}

/** Called only with the receipt of writeExecutionObject, never with guest-supplied digests. */
export async function finishUpload(
  tx: ExecutionTransaction,
  area: ExecutionArea,
  objectId: string,
  chunks: ExecutionChunk[],
) {
  await requireGeneration(tx, area.id, area.generation);
  const object = await readObject(tx, area.id, objectId);
  if (object.generation !== area.generation || object.state !== 'uploading') throw new ExecutionConflict('stale');
  validateChunks(object.size, chunks);
  const result = await tx.client.query(
    `UPDATE ${table(tx, 'tf_execution_objects')} SET chunks=$2,state='ready'
      WHERE id=$1 AND state='uploading' AND expires_at>clock_timestamp()`,
    [object.id, JSON.stringify(chunks)],
  );
  if (result.rowCount !== 1) throw new ExecutionConflict('stale');
}

export async function objectIsRetained(tx: ExecutionTransaction, objectId: string) {
  return !!(
    await tx.client.query(
      `SELECT 1 FROM ${table(tx, 'tf_execution_manifest_files')} f JOIN ${table(tx, 'tf_execution_areas')} a
      ON f.manifest_id=a.manifest_id AND f.area_id=a.id WHERE f.object_id=$1 AND a.state='active' LIMIT 1`,
      [objectId],
    )
  ).rowCount;
}

export async function beginObjectCleanup(tx: ExecutionTransaction, areaId: string, objectId: string) {
  // Serialize with commits even for areas being deleted; those still need file cleanup.
  await tx.client.query(`SELECT id FROM ${table(tx, 'tf_execution_areas')} WHERE id=$1 FOR UPDATE`, [areaId]);
  const object = await readObject(tx, areaId, objectId);
  if (object.state === 'deleted' || (await objectIsRetained(tx, object.id))) return undefined;
  const result = await tx.client.query(
    `UPDATE ${table(tx, 'tf_execution_objects')} SET state='deleting'
      WHERE id=$1 AND (expires_at<=clock_timestamp() OR
        EXISTS (SELECT 1 FROM ${table(tx, 'tf_execution_areas')} WHERE id=$2 AND state<>'active'))`,
    [object.id, areaId],
  );
  return result.rowCount ? object : undefined;
}

/** Caller holds the area and worker-claim locks and has verified this chunk's empty marker. */
export async function advanceObjectCleanup(
  tx: ExecutionTransaction,
  areaId: string,
  objectId: string,
  expected: number,
) {
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(expected);
  const result = await tx.client.query(
    `UPDATE ${table(tx, 'tf_execution_objects')} SET retired_chunks=retired_chunks+1
      WHERE id=$1 AND area_id=$2 AND state='deleting' AND retired_chunks=$3
        AND retired_chunks<ceil(size::numeric/$4::numeric)`,
    [objectId, areaId, expected, executionChunkBytes],
  );
  if (result.rowCount !== 1) throw new ExecutionConflict('stale');
}

/** Only after every chunk's permanent write fence has been installed and verified. */
export async function finishObjectCleanup(tx: ExecutionTransaction, areaId: string, objectId: string) {
  const result = await tx.client.query(
    `UPDATE ${table(tx, 'tf_execution_objects')} SET state='deleted',chunks='[]'::jsonb,
      retired_chunks=ceil(size::numeric/$3::numeric)
      WHERE id=$1 AND area_id=$2 AND state='deleting'`,
    [objectId, areaId, executionChunkBytes],
  );
  if (result.rowCount !== 1) throw new ExecutionConflict('stale');
}
