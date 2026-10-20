import { randomBytes } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

const account = '8814d00cb5fea3365054df9cee16776b';
const bucket = 'tulipfarm-cloud-soul-local';
const productionBucket = 'tulipfarm-cloud-soul-production';
const endpoint = `https://${account}.r2.cloudflarestorage.com`;
const credential = z
  .string()
  .min(1)
  .regex(/^[!-~]+$/);
const credentials = z.object({ accessKeyId: credential, secretAccessKey: credential });
const configuration = z.object({ reader: credentials, fixtureWriter: credentials });
export type ReaderQualification = z.infer<typeof configuration>;

type ConfigurationCode =
  | 'production_forbidden'
  | 'target_conflict'
  | 'session_token_unsupported'
  | 'explicit_credentials_required'
  | 'distinct_credentials_required'
  | 'arguments_forbidden';
class ConfigurationError extends Error {
  readonly code: ConfigurationCode;
  constructor(code: ConfigurationCode) {
    super(code);
    this.code = code;
  }
}

export function readerQualification(env: NodeJS.ProcessEnv): ReaderQualification {
  if (env.NODE_ENV === 'production') throw new ConfigurationError('production_forbidden');
  return qualificationCredentials(env, bucket);
}

export function productionReaderQualification(env: NodeJS.ProcessEnv): ReaderQualification {
  return qualificationCredentials(env, productionBucket);
}

function qualificationCredentials(env: NodeJS.ProcessEnv, bucket: string): ReaderQualification {
  const targets: Record<string, string> = {
    R2_SOUL_BUCKET: bucket,
    R2_ACCOUNT_ID: account,
    CLOUDFLARE_ACCOUNT_ID: account,
    R2_SOUL_ACCOUNT_ID: account,
    R2_ENDPOINT: endpoint,
    R2_S3_ENDPOINT: endpoint,
    R2_SOUL_ENDPOINT: endpoint,
    AWS_ENDPOINT_URL: endpoint,
    AWS_ENDPOINT_URL_S3: endpoint,
  };
  for (const [name, expected] of Object.entries(targets)) {
    if (env[name] !== undefined && env[name] !== expected) throw new ConfigurationError('target_conflict');
  }
  for (const name of [
    'R2_SESSION_TOKEN',
    'R2_SOUL_READ_SESSION_TOKEN',
    'R2_SOUL_SESSION_TOKEN',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
  ]) {
    if (env[name] !== undefined) throw new ConfigurationError('session_token_unsupported');
  }
  const parsed = configuration.safeParse({
    reader: { accessKeyId: env.R2_SOUL_READ_ACCESS_KEY_ID, secretAccessKey: env.R2_SOUL_READ_SECRET_ACCESS_KEY },
    fixtureWriter: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
  if (!parsed.success) throw new ConfigurationError('explicit_credentials_required');
  if (parsed.data.reader.accessKeyId === parsed.data.fixtureWriter.accessKeyId) {
    throw new ConfigurationError('distinct_credentials_required');
  }
  return parsed.data;
}

type WriteOutcome = 'not_attempted' | 'created' | 'denied' | 'collision' | 'unknown';
type Probe = { key: string; body: Buffer; nonce: string; write: WriteOutcome };
type Cleanup = {
  key: string;
  code: 'not_attempted' | 'collision_preserved' | 'absent' | 'deleted' | 'foreign_preserved' | 'unknown';
};
type ActionCode =
  | 'qualified'
  | 'fixture_collision'
  | 'fixture_write_unknown'
  | 'reader_get_failed'
  | 'reader_get_mismatch'
  | 'reader_write_allowed'
  | 'reader_write_collision'
  | 'reader_write_unknown';
type ReaderGetDiagnostic = {
  code: 'AccessDenied' | 'InvalidAccessKeyId' | 'SignatureDoesNotMatch' | 'ExpiredToken' | 'InvalidToken' | 'unknown';
  httpStatus: number | null;
};
type QualificationAction =
  | { action: Exclude<ActionCode, 'reader_get_failed'> }
  | { action: 'reader_get_failed'; diagnostic: ReaderGetDiagnostic };
type QualificationResult = QualificationAction & {
  status: 'passed' | 'failed';
  writes: { key: string; outcome: WriteOutcome }[];
  cleanup: Cleanup[];
};

function s3Error(error: unknown, name: string, status: number) {
  return error instanceof S3ServiceException && error.name === name && error.$metadata.httpStatusCode === status;
}

function readerGetDiagnostic(error: unknown): ReaderGetDiagnostic {
  if (!(error instanceof S3ServiceException)) return { code: 'unknown', httpStatus: null };
  const status = error.$metadata.httpStatusCode;
  const httpStatus = status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  switch (error.name) {
    case 'AccessDenied':
    case 'InvalidAccessKeyId':
    case 'SignatureDoesNotMatch':
    case 'ExpiredToken':
    case 'InvalidToken':
      return { code: error.name, httpStatus };
    default:
      return { code: 'unknown', httpStatus };
  }
}

type LoopbackTransport = { endpoint: string; timeoutMs: number };

export async function qualifySoulRead(
  config: ReaderQualification,
  reportKeys: (keys: string[]) => void = () => {},
  loopback?: LoopbackTransport,
): Promise<QualificationResult> {
  return runQualification(config, bucket, reportKeys, loopback);
}

export async function qualifyProductionSoulRead(
  config: ReaderQualification,
  reportKeys: (keys: string[]) => void = () => {},
  loopback?: LoopbackTransport,
): Promise<QualificationResult> {
  return runQualification(config, productionBucket, reportKeys, loopback);
}

async function runQualification(
  config: ReaderQualification,
  bucket: string,
  reportKeys: (keys: string[]) => void,
  loopback?: LoopbackTransport,
): Promise<QualificationResult> {
  let target = endpoint;
  let timeoutMs = 10_000;
  if (loopback) {
    const url = new URL(loopback.endpoint);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !Number.isInteger(loopback.timeoutMs) ||
      loopback.timeoutMs < 1 ||
      loopback.timeoutMs > timeoutMs
    )
      throw new ConfigurationError('target_conflict');
    target = url.origin;
    timeoutMs = loopback.timeoutMs;
  }
  const options = {
    region: 'auto',
    endpoint: target,
    forcePathStyle: true,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: Math.min(2000, timeoutMs),
      requestTimeout: timeoutMs,
      throwOnRequestTimeout: true,
    },
  };
  const writer = new S3Client({ ...options, credentials: config.fixtureWriter });
  const reader = new S3Client({ ...options, credentials: config.reader });
  const prefix = `qualification/soul-read/${randomBytes(24).toString('hex')}`;
  const nonce = randomBytes(24).toString('hex');
  function probe(name: string): Probe {
    return {
      key: `${prefix}/${name}`,
      body: Buffer.from(`soul-read-qualification\n${nonce}\n${name}\n`),
      nonce,
      write: 'not_attempted',
    };
  }
  const fixture = probe('fixture');
  const deniedPut = probe('denied-put');

  async function put(client: S3Client, object: Probe) {
    object.write = 'unknown';
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: object.key,
        Body: object.body,
        IfNoneMatch: '*',
        ContentType: 'application/octet-stream',
        Metadata: { 'qualification-nonce': object.nonce },
      }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
    object.write = 'created';
  }

  async function inspect(
    client: S3Client,
    probe: Probe,
  ): Promise<{ kind: 'absent' } | { kind: 'foreign' } | { kind: 'owned'; etag: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: probe.key }), {
        abortSignal: controller.signal,
      });
      if (!object.Body) return { kind: 'foreign' };
      const stream = object.Body.transformToWebStream();
      if (
        object.ContentLength !== probe.body.length ||
        object.Metadata?.['qualification-nonce'] !== probe.nonce ||
        !object.ETag
      ) {
        await stream.cancel();
        return { kind: 'foreign' };
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > probe.body.length) return { kind: 'foreign' };
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).equals(probe.body) ? { kind: 'owned', etag: object.ETag } : { kind: 'foreign' };
    } catch (error) {
      if (s3Error(error, 'NoSuchKey', 404)) return { kind: 'absent' };
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function cleanup(probe: Probe): Promise<Cleanup> {
    if (probe.write === 'not_attempted') return { key: probe.key, code: 'not_attempted' };
    if (probe.write === 'collision') return { key: probe.key, code: 'collision_preserved' };
    try {
      const before = await inspect(writer, probe);
      if (before.kind === 'absent') return { key: probe.key, code: probe.write === 'unknown' ? 'unknown' : 'absent' };
      if (before.kind === 'foreign' || probe.write === 'denied') return { key: probe.key, code: 'foreign_preserved' };
      let code: Cleanup['code'] = 'deleted';
      try {
        await writer.send(new DeleteObjectCommand({ Bucket: bucket, Key: probe.key, IfMatch: before.etag }), {
          abortSignal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        code = 'unknown';
      }
      const after = await inspect(writer, probe);
      return { key: probe.key, code: after.kind === 'absent' ? code : 'unknown' };
    } catch {
      return { key: probe.key, code: 'unknown' };
    }
  }

  async function qualify(): Promise<QualificationAction> {
    try {
      await put(writer, fixture);
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
        fixture.write = 'collision';
        return { action: 'fixture_collision' };
      }
      return { action: 'fixture_write_unknown' };
    }
    try {
      if ((await inspect(reader, fixture)).kind !== 'owned') return { action: 'reader_get_mismatch' };
    } catch (error) {
      return { action: 'reader_get_failed', diagnostic: readerGetDiagnostic(error) };
    }
    try {
      await put(reader, deniedPut);
      return { action: 'reader_write_allowed' };
    } catch (error) {
      if (s3Error(error, 'AccessDenied', 403)) {
        deniedPut.write = 'denied';
        return { action: 'qualified' };
      }
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
        deniedPut.write = 'collision';
        return { action: 'reader_write_collision' };
      }
      return { action: 'reader_write_unknown' };
    }
  }

  try {
    reportKeys([fixture.key, deniedPut.key]);
    const action = await qualify();
    const outcomes = [await cleanup(fixture), await cleanup(deniedPut)];
    return {
      status:
        action.action === 'qualified' && outcomes.every(({ code }) => code === 'absent' || code === 'deleted')
          ? 'passed'
          : 'failed',
      ...action,
      writes: [fixture, deniedPut].map(({ key, write }) => ({ key, outcome: write })),
      cleanup: outcomes,
    };
  } finally {
    reader.destroy();
    writer.destroy();
  }
}

export async function runSoulReadQualificationCli(mode: 'local' | 'production') {
  try {
    if (process.argv.length !== 2) throw new ConfigurationError('arguments_forbidden');
    const config =
      mode === 'production' ? productionReaderQualification(process.env) : readerQualification(process.env);
    const run = mode === 'production' ? qualifyProductionSoulRead : qualifySoulRead;
    const result = await run(config, keys => {
      process.stdout.write(`${JSON.stringify({ status: 'started', keys })}\n`);
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === 'passed' ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ status: 'failed', code: error instanceof ConfigurationError ? error.code : 'qualification_unknown' })}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await runSoulReadQualificationCli('local');
