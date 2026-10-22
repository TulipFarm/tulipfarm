import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createStarterBundle } from '../src/soul.ts';

export const sha256 = body => createHash('sha256').update(body).digest('hex');
export async function explorerStorage(seed) {
  const objects = new Map(),
    reads = [];
  const client = new S3Client({ region: 'auto', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
  client.send = async command => {
    const key = command.input.Key;
    if (command instanceof PutObjectCommand) {
      if (!objects.has(key))
        objects.set(key, { body: Buffer.from(command.input.Body), metadata: command.input.Metadata });
      return {};
    }
    if (!(command instanceof GetObjectCommand)) throw new Error('Unexpected fixture storage command');
    reads.push(key);
    const object = objects.get(key);
    if (!object) throw new Error('Missing fixture object');
    return {
      ContentLength: object.body.length,
      Metadata: object.metadata,
      Body: { transformToWebStream: () => new Blob([object.body]).stream() },
    };
  };
  const initial = await createStarterBundle(seed);
  const key = `workspaces/${seed.workspaceId}/soul/initial.bundle`;
  objects.set(key, { body: initial.body, metadata: { sha256: sha256(initial.body) } });
  return {
    storage: { client, bucket: 'soul-explorer-test' },
    initial: { commit: initial.commit, bucket: 'soul-explorer-test', key },
    objects,
    reads,
  };
}
