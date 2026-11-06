import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ExecutionConflict } from './state.ts';

export const executionChunkBytes = 1024 * 1024;
export const chunkSchema = z.strictObject({
  size: z.number().int().positive().max(executionChunkBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ExecutionChunk = z.infer<typeof chunkSchema>;
export type ExecutionObject = {
  workspaceId: string;
  areaId: string;
  objectId: string;
  size: number;
  sha256: string;
};
export interface ExecutionObjectBytes {
  putIfAbsent(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  read(key: string, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array>;
  /** Atomically overwrite with a permanent empty object; later conditional writes must not replace it. */
  retireExecutionChunk(key: string, signal: AbortSignal): Promise<void>;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function prefix(object: ExecutionObject) {
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(object.size);
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(object.sha256);
  return `execution/v1/${z.uuid().parse(object.workspaceId)}/${z.uuid().parse(object.areaId)}/${z.uuid().parse(object.objectId)}`;
}

/** The caller reserves this object and its cleanup intent before sending bytes. */
export async function writeExecutionObject(
  store: ExecutionObjectBytes,
  object: ExecutionObject,
  input: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<ExecutionChunk[]> {
  const key = prefix(object);
  const chunks: ExecutionChunk[] = [];
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(executionChunkBytes);
  let length = 0,
    total = 0;
  async function flush() {
    signal.throwIfAborted();
    const bytes = buffer.subarray(0, length);
    const sha256 = digest(bytes);
    await store.putIfAbsent(`${key}/${chunks.length}`, bytes, signal);
    const stored = await store.read(`${key}/${chunks.length}`, length, signal);
    if (stored.length !== length || digest(stored) !== sha256) throw new ExecutionConflict('request-conflict');
    chunks.push({ size: length, sha256 });
    length = 0;
  }
  for await (const bytes of input) {
    signal.throwIfAborted();
    if (!(bytes instanceof Uint8Array) || bytes.length > object.size - total) throw new ExecutionConflict('quota');
    hash.update(bytes);
    total += bytes.length;
    for (let offset = 0; offset < bytes.length;) {
      const count = Math.min(bytes.length - offset, executionChunkBytes - length);
      buffer.set(bytes.subarray(offset, offset + count), length);
      length += count;
      offset += count;
      if (length === executionChunkBytes) await flush();
    }
  }
  signal.throwIfAborted();
  if (total !== object.size || hash.digest('hex') !== object.sha256) throw new ExecutionConflict('request-conflict');
  if (length) await flush();
  return chunks;
}

/** Reauthorize each chunk; verify its stored digest before releasing any of that chunk to the reader. */
export async function* readExecutionObject(
  store: ExecutionObjectBytes,
  object: ExecutionObject,
  input: ExecutionChunk[],
  authorize: () => Promise<void>,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const key = prefix(object);
  const chunks = validateChunks(object.size, input);
  const hash = createHash('sha256');
  await authorize();
  for (let index = 0; index < chunks.length; index++) {
    signal.throwIfAborted();
    await authorize();
    const chunk = chunks[index]!;
    const bytes = await store.read(`${key}/${index}`, chunk.size, signal);
    if (bytes.length !== chunk.size || digest(bytes) !== chunk.sha256) throw new ExecutionConflict('request-conflict');
    await authorize();
    signal.throwIfAborted();
    hash.update(bytes);
    yield bytes;
  }
  if (hash.digest('hex') !== object.sha256) throw new ExecutionConflict('request-conflict');
}

export function validateChunks(size: number, input: ExecutionChunk[]) {
  if (input.length !== Math.ceil(size / executionChunkBytes)) throw new ExecutionConflict('request-conflict');
  const chunks = z.array(chunkSchema).parse(input);
  for (let index = 0; index < chunks.length; index++) {
    const expected = Math.min(executionChunkBytes, size - index * executionChunkBytes);
    if (chunks[index]!.size !== expected) throw new ExecutionConflict('request-conflict');
  }
  return chunks;
}

export async function removeExecutionObjectChunk(
  store: ExecutionObjectBytes,
  object: ExecutionObject,
  index: number,
  signal: AbortSignal,
) {
  const key = prefix(object);
  z.number()
    .int()
    .nonnegative()
    .max(Math.ceil(object.size / executionChunkBytes) - 1)
    .parse(index);
  signal.throwIfAborted();
  const chunkKey = `${key}/${index}`;
  await store.retireExecutionChunk(chunkKey, signal);
  if ((await store.read(chunkKey, 0, signal)).length !== 0) throw new ExecutionConflict('request-conflict');
}

export async function removeExecutionObject(store: ExecutionObjectBytes, object: ExecutionObject, signal: AbortSignal) {
  prefix(object);
  for (let index = 0; index < Math.ceil(object.size / executionChunkBytes); index++) {
    await removeExecutionObjectChunk(store, object, index, signal);
  }
}
