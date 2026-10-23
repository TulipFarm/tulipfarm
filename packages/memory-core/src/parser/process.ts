import { spawn, execFile } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:os';
import { z } from 'zod';
import { knowledgeLimits } from '../document-contracts.js';
import { KnowledgeParseError, KnowledgeParserBusy, failureSchema, metadataSchema, parserLimits } from './contracts.js';
import type { KnowledgeParseDiagnostics, KnowledgeParseInput, KnowledgeParseReason } from './contracts.js';
import {
  extractionSchema,
  mediaBatchHeaderSchema,
  mediaIdSchema,
  mediaLimits,
  mediaRefSchema,
  placeholderPattern,
} from './media-contracts.js';
import type { KnowledgeExtraction, MediaBatchHeader, MediaBytes, MediaItem } from './media-contracts.js';

let active = 0;

export const parserRetry = Object.freeze({ attempts: 3, initialDelayMs: 500 });

// Transient process failures (spawn, crash, garbled output, a failed memory sample) are retried with exponential
// backoff. Timeouts and memory limits are deterministic for the same bytes, so they fail at once.
export async function retryTransientParse<T>(
  run: () => Promise<T>,
  options: { attempts?: number; initialDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? parserRetry.attempts;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !transient(error)) throw error;
      await sleep((options.initialDelayMs ?? parserRetry.initialDelayMs) * 2 ** (attempt - 1));
    }
  }
}

export function transient(error: unknown) {
  return error instanceof KnowledgeParseError && error.retryable && !['timeout', 'rss-limit'].includes(error.reason);
}

export interface SandboxOptions {
  worker?: URL;
  timeoutMs?: number;
  memoryBytes?: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  residentBytes?: (pid: number) => Promise<number>;
}

type MediaRequest = Pick<MediaItem, 'id' | 'kind' | 'ref'>;
type WorkerRequest = { mode: 'extract' } | { mode: 'media'; items: MediaRequest[] };

const failedSchema = z.strictObject({ kind: z.literal('failed'), failure: failureSchema });
const extractResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), extraction: extractionSchema }),
  failedSchema,
]);
const headerSlackBytes = 1024 * 1024;

/** Sandbox call 1: text segments with media placeholders, media items and coverage gaps. */
export async function extractKnowledgeDocument(
  input: KnowledgeParseInput,
  options: SandboxOptions = {},
): Promise<KnowledgeExtraction> {
  const { output, diagnostics } = await runSandbox(input, { mode: 'extract' }, parserLimits.outputBytes, options);
  let response: z.infer<typeof extractResponseSchema>;
  try {
    response = extractResponseSchema.parse(JSON.parse(output.toString('utf8')));
  } catch {
    throw invalid(diagnostics);
  }
  if (response.kind === 'failed') throw new KnowledgeParseError(response.failure, { diagnostics });
  const { extraction } = response;
  // Every media item is placed exactly once, and no placeholder names unknown media.
  const placed = new Map<string, number>();
  for (const segment of extraction.segments) {
    for (const match of segment.markdown.matchAll(placeholderPattern)) {
      const id = match[1] ?? '';
      placed.set(id, (placed.get(id) ?? 0) + 1);
    }
    if (segment.markdown.replace(placeholderPattern, '').match(/[\uE000\uE001]/)) throw invalid(diagnostics);
  }
  const ids = new Set(extraction.media.map(item => item.id));
  if (
    ids.size !== extraction.media.length ||
    placed.size !== ids.size ||
    [...placed].some(([id, count]) => count !== 1 || !ids.has(id))
  )
    throw invalid(diagnostics);
  return extraction;
}

/** @deprecated Use `extractKnowledgeDocument`; kept for callers that only need the sandbox run. */
export const runParserProcess = extractKnowledgeDocument;

/**
 * Sandbox call 2: normalized bytes for up to `mediaLimits.batchItems` media items. Ready items past
 * `mediaLimits.batchBytes` come back `deferred` and must be requested again.
 */
export async function readKnowledgeMedia(
  input: KnowledgeParseInput,
  items: MediaRequest[],
  options: SandboxOptions = {},
): Promise<{ header: MediaBatchHeader; media: MediaBytes[] }> {
  if (!items.length || items.length > mediaLimits.batchItems) throw new KnowledgeParseError('resource-limited');
  const requested = items.map(({ id, kind, ref }) => ({ id, kind, ref }));
  if (
    new Set(requested.map(item => item.id)).size !== requested.length ||
    !requested.every(item => mediaIdSchema.safeParse(item.id).success && mediaRefSchema.safeParse(item.ref).success)
  )
    throw new KnowledgeParseError('malformed');
  const { output, diagnostics } = await runSandbox(
    input,
    { mode: 'media', items: requested },
    mediaLimits.batchBytes + headerSlackBytes,
    options,
  );
  const newline = output.indexOf(0x0a);
  let header: MediaBatchHeader;
  try {
    const value: unknown = JSON.parse(output.subarray(0, newline === -1 ? output.length : newline).toString('utf8'));
    const failed = failedSchema.safeParse(value);
    if (failed.success) throw new KnowledgeParseError(failed.data.failure, { diagnostics });
    if (newline === -1) throw invalid(diagnostics);
    header = mediaBatchHeaderSchema.parse(value);
  } catch (error) {
    if (error instanceof KnowledgeParseError) throw error;
    throw invalid(diagnostics);
  }
  if (
    header.items.length !== requested.length ||
    header.items.some((entry, index) => entry.id !== requested[index]?.id)
  )
    throw invalid(diagnostics);
  const body = output.subarray(newline + 1);
  const media: MediaBytes[] = [];
  let offset = 0;
  let total = 0;
  for (const entry of header.items) {
    if (entry.status !== 'ready') continue;
    total += entry.byteLength;
    if (offset + entry.byteLength > body.length || (media.length && total > mediaLimits.batchBytes))
      throw invalid(diagnostics);
    media.push({
      id: entry.id,
      mediaType: entry.mediaType,
      width: entry.width,
      height: entry.height,
      bytes: new Uint8Array(body.subarray(offset, offset + entry.byteLength)),
    });
    offset += entry.byteLength;
  }
  if (offset !== body.length) throw invalid(diagnostics);
  return { header, media };
}

function invalid(diagnostics: KnowledgeParseDiagnostics): KnowledgeParseError {
  return new KnowledgeParseError('malformed', { reason: 'invalid-output', diagnostics });
}

async function runSandbox(
  input: KnowledgeParseInput,
  request: WorkerRequest,
  outputLimit: number,
  options: SandboxOptions,
): Promise<{ output: Buffer; diagnostics: KnowledgeParseDiagnostics }> {
  if (
    !(input.bytes instanceof Uint8Array) ||
    !metadataSchema.safeParse({ filename: input.filename, mediaType: input.mediaType }).success
  ) {
    throw new KnowledgeParseError('malformed');
  }
  if (input.bytes.byteLength === 0) throw new KnowledgeParseError('malformed');
  if (options.signal?.aborted) throw new KnowledgeParseError('resource-limited', { reason: 'cancelled' });
  if (input.bytes.byteLength > knowledgeLimits.originalBytes) throw new KnowledgeParseError('resource-limited');
  if (active >= parserLimits.concurrency) throw new KnowledgeParserBusy();
  if (process.platform !== 'linux' && process.platform !== 'darwin')
    throw new KnowledgeParseError('resource-limited', { reason: 'unsupported-platform' });
  active += 1;
  try {
    return await execute(
      input,
      JSON.stringify({
        filename: input.filename,
        mediaType: input.mediaType,
        ...(request.mode === 'extract' && input.rawTextFallback === true ? { rawTextFallback: true } : {}),
        ...request,
      }),
      outputLimit,
      options,
    );
  } finally {
    active -= 1;
  }
}

function execute(
  input: KnowledgeParseInput,
  argument: string,
  outputLimit: number,
  options: SandboxOptions,
): Promise<{ output: Buffer; diagnostics: KnowledgeParseDiagnostics }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const worker = options.worker ?? new URL('./worker.js', import.meta.url);
    const memoryLimit = process.platform === 'linux' ? `ulimit -d ${parserLimits.dataKiB} && ` : '';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        '/bin/sh',
        [
          '-c',
          `ulimit -c 0 && ulimit -f 0 && ulimit -t 25 && ${memoryLimit}exec "$@"`,
          'knowledge-parser',
          process.execPath,
          '--max-old-space-size=256',
          '--jitless',
          fileURLToPath(worker),
          argument,
        ],
        {
          cwd: '/',
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            PATH: '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            TZ: 'UTC',
            UV_THREADPOOL_SIZE: '1',
            NAPI_RS_ENFORCE_VERSION_CHECK: '1',
          },
        },
      );
    } catch {
      reject(
        new KnowledgeParseError('resource-limited', {
          reason: 'spawn',
          diagnostics: { elapsedMs: Math.floor(performance.now() - started) },
        }),
      );
      return;
    }
    let failure: KnowledgeParseReason | undefined;
    let outputBytes = 0;
    let diagnosticBytes = 0;
    const output: Buffer[] = [];
    let sampling = false;
    let rssBytes = 0;
    const stop = (reason: KnowledgeParseReason) => {
      failure ??= reason;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const abort = () => stop('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? parserLimits.timeoutMs);
    // RSS includes native allocations, unlike V8's heap limit. Sampling is outside the parser process.
    const monitor = setInterval(() => {
      if (sampling || !child.pid || failure) return;
      sampling = true;
      void (options.residentBytes ?? residentBytes)(child.pid)
        .then(rss => {
          sampling = false;
          if (failure || child.exitCode !== null || child.signalCode !== null) return;
          if (!Number.isSafeInteger(rss) || rss < 0) {
            stop('memory-monitor');
            return;
          }
          rssBytes = Math.max(rssBytes, rss);
          if (rss > (options.memoryBytes ?? parserLimits.memoryBytes)) stop('rss-limit');
        })
        .catch(() => {
          sampling = false;
          if (failure || child.exitCode !== null || child.signalCode !== null) return;
          try {
            process.kill(child.pid ?? 0, 0);
          } catch {
            return;
          }
          stop('memory-monitor');
        });
    }, 50);
    child.stdout.on('data', (bytes: Buffer) => {
      outputBytes += bytes.length;
      if (outputBytes > outputLimit) stop('output-limit');
      else if (!failure) output.push(bytes);
    });
    child.stderr.on('data', (bytes: Buffer) => {
      diagnosticBytes += bytes.length;
      if (diagnosticBytes > parserLimits.diagnosticBytes) stop('diagnostic-limit');
    });
    child.stdin.on('error', function awaitProcessClose() {});
    child.on('error', () => stop('spawn'));
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearInterval(monitor);
      options.signal?.removeEventListener('abort', abort);
      const diagnostics: KnowledgeParseDiagnostics = {
        elapsedMs: Math.floor(performance.now() - started),
        outputBytes,
        diagnosticBytes,
        rssBytes,
        ...(code !== null ? { exitCode: code } : {}),
        ...(signal ? { signalNumber: constants.signals[signal] } : {}),
      };
      if (failure) {
        reject(new KnowledgeParseError('resource-limited', { reason: failure, diagnostics }));
        return;
      }
      if (code !== 0 || signal) {
        reject(new KnowledgeParseError('resource-limited', { reason: 'abnormal-exit', diagnostics }));
        return;
      }
      resolve({ output: Buffer.concat(output), diagnostics });
    });
    child.stdin.end(Buffer.from(input.bytes));
    if (child.pid) options.onSpawn?.(child.pid);
    if (options.signal?.aborted) abort();
  });
}

export function residentBytesFromProcStatus(status: string): number {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  if (match?.[1]) return Number(match[1]) * 1024;
  // An exiting process releases its address space before it becomes a zombie, so VmRSS disappears first.
  if (/^State:\s+\S/m.test(status)) return 0;
  throw new Error('Parser memory is unavailable');
}

async function residentBytes(pid: number): Promise<number> {
  if (process.platform === 'linux') {
    return residentBytesFromProcStatus(
      await readFile(`/proc/${pid}/status`, { encoding: 'utf8', signal: AbortSignal.timeout(1000) }),
    );
  }
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-o', 'rss=', '-p', String(pid)],
      {
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
        timeout: 1000,
        maxBuffer: 1024,
      },
      (error, stdout) => {
        if (error && (error.code !== 1 || stdout.trim())) {
          reject(error);
          return;
        }
        const bytes = Number(stdout.trim()) * 1024;
        if (!Number.isFinite(bytes)) reject(new Error('Parser memory is unavailable'));
        else resolve(bytes);
      },
    );
  });
}
