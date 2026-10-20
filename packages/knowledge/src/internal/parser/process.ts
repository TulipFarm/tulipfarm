import { spawn, execFile } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:os';
import { knowledgeLimits } from '../contracts.js';
import { KnowledgeParseError, KnowledgeParserBusy, metadataSchema, parserLimits, responseSchema } from './contracts.js';
import type {
  KnowledgeParseDiagnostics,
  KnowledgeParseInput,
  KnowledgeParseReason,
  KnowledgeParseResult,
} from './contracts.js';

let active = 0;

export function parseKnowledgeDocument(input: KnowledgeParseInput): Promise<KnowledgeParseResult> {
  return runParserProcess(input);
}

export async function runParserProcess(
  input: KnowledgeParseInput,
  options: {
    worker?: URL;
    timeoutMs?: number;
    memoryBytes?: number;
    signal?: AbortSignal;
    onSpawn?: (pid: number) => void;
    residentBytes?: (pid: number) => Promise<number>;
  } = {},
): Promise<KnowledgeParseResult> {
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
    return await execute(input, options);
  } finally {
    active -= 1;
  }
}

function execute(
  input: KnowledgeParseInput,
  options: {
    worker?: URL;
    timeoutMs?: number;
    memoryBytes?: number;
    signal?: AbortSignal;
    onSpawn?: (pid: number) => void;
    residentBytes?: (pid: number) => Promise<number>;
  },
): Promise<KnowledgeParseResult> {
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
          JSON.stringify({ filename: input.filename, mediaType: input.mediaType }),
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
      if (outputBytes > parserLimits.outputBytes) stop('output-limit');
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
      try {
        const value: unknown = JSON.parse(Buffer.concat(output).toString('utf8'));
        const response = responseSchema.parse(value);
        if (response.kind === 'failed') reject(new KnowledgeParseError(response.failure, { diagnostics }));
        else resolve(response.result);
      } catch {
        reject(new KnowledgeParseError('malformed', { reason: 'invalid-output', diagnostics }));
      }
    });
    child.stdin.end(Buffer.from(input.bytes));
    if (child.pid) options.onSpawn?.(child.pid);
    if (options.signal?.aborted) abort();
  });
}

async function residentBytes(pid: number): Promise<number> {
  if (process.platform === 'linux') {
    const status = await readFile(`/proc/${pid}/status`, { encoding: 'utf8', signal: AbortSignal.timeout(1000) });
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (match?.[1]) return Number(match[1]) * 1024;
    if (/^State:\s+Z/m.test(status)) return 0;
    throw new Error('Parser memory is unavailable');
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
