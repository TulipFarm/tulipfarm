import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { executionSchema, snippetPayloadSchema } from './protocol.ts';
import { maxSkillJobBytes, skillJobSchema, skillResultSchema } from './skill-protocol.ts';

const json = z.json();
export const snippetSchema = executionSchema;
export class SnippetError extends Error {
  readonly code:
    | 'invalid-input'
    | 'unavailable'
    | 'deadline'
    | 'output-limit'
    | 'execution-failed'
    | 'invalid-output'
    | 'cleanup-failed';
  constructor(code: SnippetError['code']) {
    super(code);
    this.code = code;
  }
}

export function parseSnippet(value: unknown) {
  const result = snippetSchema.safeParse(value);
  if (!result.success) throw new SnippetError('invalid-input');
  return result.data;
}

export function createSnippetRunner(options: {
  image: string;
  runtime?: 'runsc' | 'runc';
  allowLocalRunc?: boolean;
  timeoutMs?: number;
  owner?: string;
}) {
  const image = z
    .string()
    .regex(/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/)
    .parse(options.image);
  if (process.env.NODE_ENV === 'production' && !image.includes('@sha256:')) throw new SnippetError('unavailable');
  const runtime = options.runtime ?? 'runsc';
  if (runtime === 'runc' && (!options.allowLocalRunc || process.env.NODE_ENV === 'production'))
    throw new SnippetError('unavailable');
  const timeoutMs = z
    .number()
    .int()
    .min(100)
    .max(30000)
    .parse(options.timeoutMs ?? 10000);
  const owner = z.uuid().parse(options.owner ?? randomUUID());
  const packageRoot = join(tmpdir(), `tf-skills-${owner}`);
  const active = new Set<string>();
  const uncertain = new Set<string>();
  let reconciling = false;

  async function execute(value: unknown, packageJob = false): Promise<z.infer<typeof json>> {
    const input = packageJob ? skillJobSchema.parse(value) : parseSnippet(value);
    const maxOutput = packageJob ? maxSkillJobBytes : 131072;
    if (uncertain.size) throw new SnippetError('cleanup-failed');
    if (reconciling || active.size >= 4) throw new SnippetError('unavailable');
    const name = `tf-snippet-${randomUUID()}`;
    active.add(name);
    let packageDirectory: string | undefined;
    try {
      if ('files' in input) {
        await mkdir(packageRoot, { recursive: true, mode: 0o755 });
        packageDirectory = await mkdtemp(join(packageRoot, 'package-'));
        const paths = new Set<string>();
        let bytes = 0;
        for (const file of input.files) {
          const decoded = Buffer.from(file.content, 'base64');
          bytes += decoded.length;
          if (
            bytes > 10 * 1024 * 1024 ||
            paths.has(file.path.toLowerCase()) ||
            createHash('sha256').update(decoded).digest('hex') !== file.digest
          )
            throw new SnippetError('invalid-input');
          paths.add(file.path.toLowerCase());
          const path = join(packageDirectory, file.path);
          await mkdir(dirname(path), { recursive: true, mode: 0o755 });
          await writeFile(path, decoded, { flag: 'wx', mode: 0o444 });
        }
        if (!paths.has(input.entrypoint.toLowerCase())) throw new SnippetError('invalid-input');
        await chmod(packageDirectory, 0o755);
      }
    } catch (error) {
      active.delete(name);
      if (packageDirectory) await rm(packageDirectory, { recursive: true });
      throw error;
    }
    const outcome = await new Promise<z.infer<typeof json>>((resolve, reject) => {
      const child = spawn(
        'docker',
        [
          'run',
          '--rm',
          '--pull=never',
          '--name',
          name,
          '--label',
          `ai.tulipfarm.snippet-owner=${owner}`,
          '--runtime',
          runtime,
          '--network=none',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          ...(packageJob
            ? ['--memory=256m', '--memory-swap=256m', '--cpus=1', '--pids-limit=32']
            : ['--memory=128m', '--memory-swap=128m', '--cpus=0.5', '--pids-limit=16']),
          '--ulimit=nofile=64:64',
          '--user=65534:65534',
          `--tmpfs=/tmp:rw,noexec,nosuid,size=${packageJob ? '64m' : '8m'}`,
          '--log-driver=none',
          ...(packageDirectory ? ['--mount', `type=bind,source=${packageDirectory},target=/package,readonly`] : []),
          '-i',
          image,
          packageJob ? 'skill-package-v1' : input.language,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      );
      const output: Buffer[] = [];
      let size = 0;
      let failure: SnippetError | undefined;
      const stop = (error: SnippetError) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(
        () => stop(new SnippetError('deadline')),
        packageJob ? (options.timeoutMs ?? 30000) : timeoutMs,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxOutput) stop(new SnippetError('output-limit'));
        else output.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxOutput) stop(new SnippetError('output-limit'));
      });
      child.stdin.on('error', () => {
        failure ??= new SnippetError('execution-failed');
      });
      child.on('error', () => {
        failure ??= new SnippetError('unavailable');
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (failure || code !== 0) {
          reject(failure ?? new SnippetError(code === 125 ? 'unavailable' : 'execution-failed'));
          return;
        }
        try {
          const value = json.parse(JSON.parse(Buffer.concat(output).toString('utf8')));
          if (!(packageJob ? skillResultSchema : snippetPayloadSchema).safeParse(value).success) {
            reject(new SnippetError('output-limit'));
            return;
          }
          resolve(value);
        } catch {
          reject(new SnippetError('invalid-output'));
        }
      });
      child.stdin.end(
        JSON.stringify(
          'files' in input
            ? { language: input.language, entrypoint: input.entrypoint, args: input.args, input: input.input }
            : input,
        ),
      );
    }).then(
      value => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await docker(['rm', '-f', name]).catch(() => undefined);
      for (let attempt = 0; ; attempt++) {
        if (!(await docker(['ps', '-aq', '--filter', `name=^/${name}$`])).trim()) break;
        if (attempt === 20) throw new SnippetError('cleanup-failed');
        await delay(100);
      }
      if (packageDirectory) await rm(packageDirectory, { recursive: true });
    } catch {
      uncertain.add(name);
      throw new SnippetError('cleanup-failed');
    } finally {
      active.delete(name);
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  async function reconcile() {
    if (active.size || reconciling) throw new SnippetError('unavailable');
    reconciling = true;
    try {
      const ids = await docker(['ps', '-aq', '--filter', `label=ai.tulipfarm.snippet-owner=${owner}`]);
      for (const id of ids.trim().split(/\s+/).filter(Boolean)) {
        if (!/^[a-f0-9]{12,64}$/.test(id)) throw new SnippetError('unavailable');
        await docker(['rm', '-f', id]);
      }
      if ((await docker(['ps', '-aq', '--filter', `label=ai.tulipfarm.snippet-owner=${owner}`])).trim())
        throw new SnippetError('cleanup-failed');
      await mkdir(packageRoot, { recursive: true, mode: 0o755 });
      for (const entry of await readdir(packageRoot))
        await rm(join(packageRoot, entry), { recursive: true, force: true });
      uncertain.clear();
    } finally {
      reconciling = false;
    }
  }
  return {
    execute: (value: unknown) => execute(value),
    executeSkill: (value: unknown) => execute(value, true),
    reconcile,
  };
}

function docker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 65536) child.kill('SIGKILL');
    });
    child.on('error', () => undefined);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new SnippetError('unavailable'));
    });
  });
}
