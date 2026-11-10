import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { executionFileSchema, executionPathSchema, type ExecutionPolicy } from '@tulipfarm/execution-contract';
import { requireGeneration } from './allocations.ts';
import { readObject } from './uploads.ts';
import { ExecutionConflict, table, type ExecutionArea, type ExecutionTransaction } from './state.ts';

export const retainedFileSchema = executionFileSchema.extend({ objectId: z.uuid(), sources: z.array(z.unknown()) });
export type RetainedExecutionFile = z.infer<typeof retainedFileSchema>;

/** Acquire before chat/area locks when replacing a manifest, so concurrent chats cannot exceed the workspace quota. */
export async function lockExecutionStorage(tx: ExecutionTransaction) {
  await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 209872))', [tx.schema]);
}

/** Only trusted, integrity-checked uploads reach this commit; a guest file list cannot publish retained files. */
export async function commitManifest(
  tx: ExecutionTransaction,
  area: ExecutionArea,
  expectedParent: string | null,
  input: RetainedExecutionFile[],
  limits: ExecutionPolicy['limits'],
) {
  if (input.length > limits.fileCount) throw new ExecutionConflict('quota');
  const files = z.array(retainedFileSchema).parse(input);
  const paths = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (paths.has(file.path)) throw new ExecutionConflict('request-conflict');
    paths.add(file.path);
    total += file.size;
    if (file.size > limits.fileBytes || !Number.isSafeInteger(total) || total > limits.workspaceStorageBytes)
      throw new ExecutionConflict('quota');
  }
  await requireGeneration(tx, area.id, area.generation);
  const parent = (
    await tx.client.query(
      `SELECT 1 FROM ${table(tx, 'tf_execution_areas')} WHERE id=$1 AND manifest_id IS NOT DISTINCT FROM $2::uuid`,
      [area.id, expectedParent],
    )
  ).rowCount;
  if (!parent) throw new ExecutionConflict('stale');
  for (const file of files) {
    const object = await readObject(tx, area.id, file.objectId);
    if (
      object.state !== 'ready' ||
      object.size !== file.size ||
      object.sha256 !== file.sha256 ||
      !isDeepStrictEqual(object.sources, file.sources)
    )
      throw new ExecutionConflict('request-conflict');
  }
  const usage = z.object({ bytes: z.string() }).parse(
    (
      await tx.client.query(
        `SELECT COALESCE(sum(m.total_bytes),0)::text AS bytes FROM ${table(tx, 'tf_execution_areas')} a
      JOIN ${table(tx, 'tf_execution_manifests')} m ON m.id=a.manifest_id AND m.area_id=a.id
      WHERE a.id<>$1 AND a.state<>'deleted'`,
        [area.id],
      )
    ).rows[0],
  );
  if (BigInt(usage.bytes) + BigInt(total) > BigInt(limits.workspaceStorageBytes)) throw new ExecutionConflict('quota');
  const id = randomUUID();
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_execution_manifests')} (id,area_id,generation,parent_id,file_count,total_bytes)
      VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, area.id, area.generation, expectedParent, files.length, total],
  );
  for (const file of files) {
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_execution_manifest_files')}
        (area_id,manifest_id,path,size,sha256,executable,object_id,sources) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [area.id, id, file.path, file.size, file.sha256, file.executable, file.objectId, JSON.stringify(file.sources)],
    );
  }
  await tx.client.query(`UPDATE ${table(tx, 'tf_execution_areas')} SET manifest_id=$2 WHERE id=$1`, [area.id, id]);
  if (expectedParent) {
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_execution_outbox')} (id,area_id,generation,object_id,operation,dedupe_key,available_at)
        SELECT gen_random_uuid(),$1,$2,old.object_id,'file-cleanup',$3::text||':'||old.object_id::text,
          GREATEST(clock_timestamp(),o.expires_at)
        FROM ${table(tx, 'tf_execution_manifest_files')} old JOIN ${table(tx, 'tf_execution_objects')} o ON o.id=old.object_id
        WHERE old.manifest_id=$4 AND old.area_id=$1 AND NOT EXISTS (
          SELECT 1 FROM ${table(tx, 'tf_execution_manifest_files')} current WHERE current.manifest_id=$3::uuid AND current.object_id=old.object_id)
        ON CONFLICT (dedupe_key) DO NOTHING`,
      [area.id, area.generation, id, expectedParent],
    );
  }
  return { id, fileCount: files.length, totalBytes: total };
}

export async function manifestFiles(
  tx: ExecutionTransaction,
  area: ExecutionArea,
  after: string | null,
  limit: number,
) {
  z.number().int().min(1).max(100).parse(limit);
  return z.array(retainedFileSchema).parse(
    (
      await tx.client.query(
        `SELECT path,size::double precision AS size,sha256,executable,object_id AS "objectId",sources
      FROM ${table(tx, 'tf_execution_manifest_files')}
      WHERE area_id=$1 AND manifest_id=$2 AND ($3::text IS NULL OR path COLLATE "C">$3 COLLATE "C")
      ORDER BY path COLLATE "C" LIMIT $4`,
        [area.id, area.manifest_id, after, limit],
      )
    ).rows,
  );
}

export async function manifestFile(tx: ExecutionTransaction, area: ExecutionArea, path: string) {
  const file = retainedFileSchema.optional().parse(
    (
      await tx.client.query(
        `SELECT path,size::double precision AS size,sha256,executable,object_id AS "objectId",sources
      FROM ${table(tx, 'tf_execution_manifest_files')} WHERE area_id=$1 AND manifest_id=$2 AND path=$3`,
        [area.id, area.manifest_id, executionPathSchema.parse(path)],
      )
    ).rows[0],
  );
  if (!file) throw new ExecutionConflict('not-found');
  return file;
}
