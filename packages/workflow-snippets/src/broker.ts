import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createSnippetRunner, SnippetError } from './index.ts';
import { jobSchema, maxJobBytes, resultSchema, type SnippetResult } from './protocol.ts';
import { canonical } from './canonical.ts';
import { skillJobSchema, skillResultSchema, maxSkillJobBytes, type SkillResult } from './skill-protocol.ts';

const rowSchema = z.object({
  id: z.string(),
  request: z.string(),
  digest: z.string(),
  attempts: z.number(),
  result: z.string().nullable(),
});

export async function createSnippetBroker(options: {
  database: string;
  token: string;
  image: string;
  runtime?: 'runsc' | 'runc';
  allowLocalRunc?: boolean;
  timeoutMs?: number;
  enableSkillJobs?: boolean;
}) {
  const token = Buffer.from(
    z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(options.token),
  );
  const db = new DatabaseSync(options.database);
  let runner: ReturnType<typeof createSnippetRunner>;
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE;
      BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS identity (id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, request TEXT NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, result TEXT);
      COMMIT;`);
    const owner = db.prepare('SELECT id FROM identity').get()?.id ?? randomUUID();
    if (!db.prepare('SELECT id FROM identity').get())
      db.prepare('INSERT INTO identity VALUES (?)').run(z.string().parse(owner));
    runner = createSnippetRunner({ ...options, owner: z.uuid().parse(owner) });
    await runner.reconcile();
    db.prepare(
      "UPDATE jobs SET state='failed',result=?,request='' WHERE state='running' AND json_extract(request,'$.kind')='skill'",
    ).run(JSON.stringify({ kind: 'failed', error: 'interrupted' }));
    db.prepare("UPDATE jobs SET state='queued' WHERE state='running' AND attempts<3").run();
    db.prepare("UPDATE jobs SET state='failed',result=?,request='' WHERE state='running'").run(
      JSON.stringify({ kind: 'failed', error: 'interrupted' }),
    );
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false;
  const active = new Map<string, Promise<void>>();
  const workspaces = new Map<string, number>();
  function pump() {
    if (closed) return;
    const rows = db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY rowid LIMIT 100").all();
    for (const raw of rows) {
      if (active.size >= 4) break;
      const row = rowSchema.parse(raw),
        job = z.union([jobSchema, skillJobSchema]).parse(JSON.parse(row.request));
      if ((workspaces.get(job.workspaceId) ?? 0) >= 2) continue;
      db.prepare("UPDATE jobs SET state='running',attempts=attempts+1 WHERE id=?").run(row.id);
      workspaces.set(job.workspaceId, (workspaces.get(job.workspaceId) ?? 0) + 1);
      const task = (async () => {
        let result: SnippetResult | SkillResult;
        try {
          if ('kind' in job) {
            if (!options.enableSkillJobs) throw new SnippetError('unavailable');
            result = skillResultSchema.parse(await runner.executeSkill(job));
          } else {
            const output = await runner.execute({ language: job.language, source: job.source, input: job.input });
            const parsed = resultSchema.safeParse({ kind: 'completed', output });
            result = parsed.success ? parsed.data : { kind: 'failed', error: 'output-limit' };
          }
        } catch (error) {
          if (error instanceof SnippetError && error.code === 'cleanup-failed') throw error;
          result = { kind: 'failed', error: error instanceof SnippetError ? error.code : 'unavailable' };
        }
        db.prepare('UPDATE jobs SET state=?,result=?,request=? WHERE id=?').run(
          result.kind,
          JSON.stringify(result),
          '',
          row.id,
        );
      })()
        .catch(() => {
          closed = true;
          server.close();
        })
        .finally(() => {
          active.delete(row.id);
          workspaces.set(job.workspaceId, (workspaces.get(job.workspaceId) ?? 1) - 1);
          pump();
        });
      active.set(row.id, task);
    }
  }
  const server = createServer(
    { requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 8192 },
    async (request, response) => {
      const send = (status: number, value: unknown) => {
        if (response.headersSent || response.destroyed) return;
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify(value));
      };
      if (request.method === 'GET' && request.url === '/health/skill-runtime') {
        send(closed ? 503 : 200, {
          available: !closed && options.enableSkillJobs === true,
          profile: 'skill-runtime-v1',
        });
        request.resume();
        return;
      }
      const supplied = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (
        supplied.length !== token.length ||
        !timingSafeEqual(supplied, token) ||
        !request.headers.authorization?.startsWith('Bearer ')
      ) {
        send(401, { error: 'unauthorized' });
        request.resume();
        return;
      }
      if (closed) {
        send(503, { error: 'unavailable' });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/skill-runtime') {
        send(200, { available: options.enableSkillJobs === true, profile: 'skill-runtime-v1' });
        request.resume();
        return;
      }
      const skillRequest = request.url === '/v1/skill-jobs';
      if (request.method !== 'POST' || (request.url !== '/v1/jobs' && !skillRequest)) {
        send(404, { error: 'not-found' });
        request.resume();
        return;
      }
      if (skillRequest && !options.enableSkillJobs) {
        send(503, { error: 'skill-runtime-unavailable' });
        request.resume();
        return;
      }
      if (request.headers['content-type'] !== 'application/json') {
        send(415, { error: 'invalid-content-type' });
        request.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of request) {
          size += chunk.length;
          if (size > (skillRequest ? maxSkillJobBytes : maxJobBytes)) {
            send(413, { error: 'request-too-large' });
            return;
          }
          chunks.push(chunk);
        }
        const parsed = (skillRequest ? skillJobSchema : jobSchema).safeParse(
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
        if (!parsed.success) {
          send(400, { error: 'invalid-request' });
          return;
        }
        const job = parsed.data,
          body = canonical(job);
        const digest = createHash('sha256').update(body).digest('hex');
        const id =
          'kind' in job
            ? [job.workspaceId, 'skill', job.invocationId].join('/')
            : [job.workspaceId, job.runId, job.revision, job.stepId].join('/');
        const existing = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
        if (existing) {
          const row = rowSchema.parse(existing);
          if (row.digest !== digest) {
            send(409, { error: 'request-conflict' });
            return;
          }
          send(
            row.result ? 200 : 202,
            row.result
              ? (skillRequest ? skillResultSchema : resultSchema).parse(JSON.parse(row.result))
              : { kind: 'pending' },
          );
          return;
        }
        const count = (sql: string, args: string[] = []) => z.number().parse(db.prepare(sql).get(...args)?.count);
        if (
          count('SELECT count(*) AS count FROM jobs') >= 10000 ||
          count('SELECT count(*) AS count FROM jobs WHERE workspace=?', [job.workspaceId]) >= 1000 ||
          count("SELECT count(*) AS count FROM jobs WHERE state IN ('queued','running')") >= 32 ||
          count("SELECT count(*) AS count FROM jobs WHERE workspace=? AND state IN ('queued','running')", [
            job.workspaceId,
          ]) >= 4
        ) {
          send(429, { error: 'capacity' });
          return;
        }
        db.prepare("INSERT INTO jobs (id,workspace,request,digest,state) VALUES (?,?,?,?,'queued')").run(
          id,
          job.workspaceId,
          body,
          digest,
        );
        send(202, { kind: 'pending' });
        pump();
      } catch (error) {
        if (error instanceof SyntaxError) send(400, { error: 'invalid-request' });
        else send(503, { error: 'unavailable' });
      }
    },
  );
  server.maxConnections = 64;
  server.keepAliveTimeout = 1000;
  pump();
  return {
    server,
    async close() {
      closed = true;
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) resolve();
        else server.close(error => (error ? reject(error) : resolve()));
      });
      await Promise.allSettled(active.values());
      db.close();
    },
  };
}
