import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  browserActionSchema,
  browserControlSchema,
  browserInputsSchema,
  browserNeedsPersonSchema,
  browserOpenSchema,
  browserLoadLoginSchema,
  browserSiteStateRequestSchema,
  browserSessionIdSchema,
  browserTypeSecretSchema,
} from '@tulipfarm/browser/contracts';
import { HostError, type BrowserHost } from './host.ts';

const maxBody = 64 * 1024;
// A browser login's cookies and storage, which the service caps at 2 MB.
const maxLoginBody = 4 * 1024 * 1024;

function send(response: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

async function readJson(request: IncomingMessage, limit = maxBody): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HostError('invalid-request', 'The request body is too large.', 413);
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HostError('invalid-request', 'The request body is not JSON.', 400);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new HostError('invalid-request', parsed.error.issues.map(issue => issue.message).join('; '), 400);
  return parsed.data;
}

function authorized(request: IncomingMessage, token: string) {
  const header = request.headers.authorization ?? '';
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The browser host's HTTP API. Every route except `/health` needs the bearer token. */
export function createBrowserHostServer(host: BrowserHost, token: string): Server {
  return createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HostError) send(response, error.status, { error: error.code, message: error.message });
      else {
        console.error('browser host request failed', error);
        send(response, 500, { error: 'action-failed', message: 'The browser host failed.' });
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://host');
    const method = request.method ?? 'GET';
    if (url.pathname === '/health' && method === 'GET') return send(response, 200, { ok: true, sessions: host.size() });
    if (!authorized(request, token)) return send(response, 401, { error: 'invalid-request', message: 'Unauthorized' });

    if (url.pathname === '/v1/sessions' && method === 'POST') {
      const { sessionId, allowedSites } = parse(browserOpenSchema, await readJson(request));
      return send(response, 200, await host.open(sessionId, allowedSites));
    }
    const match = /^\/v1\/sessions\/([^/]+)(?:\/([a-z-]+))?$/.exec(url.pathname);
    if (!match) return send(response, 404, { error: 'invalid-request', message: 'Not found' });
    const sessionId = parse(browserSessionIdSchema, decodeURIComponent(match[1] ?? ''));
    const route = `${method} ${match[2] ?? ''}`;
    switch (route) {
      case 'GET ':
        return send(response, 200, await host.state(sessionId));
      case 'DELETE ':
        await host.close(sessionId);
        return send(response, 204);
      case 'POST actions':
        return send(response, 200, await host.act(sessionId, parse(browserActionSchema, await readJson(request))));
      case 'POST secrets':
        return send(
          response,
          200,
          await host.typeSecret(sessionId, parse(browserTypeSecretSchema, await readJson(request))),
        );
      case 'POST control':
        return send(response, 200, await host.control(sessionId, parse(browserControlSchema, await readJson(request))));
      case 'POST needs-person':
        return send(
          response,
          200,
          await host.needsPerson(sessionId, parse(browserNeedsPersonSchema, await readJson(request))),
        );
      case 'POST logins':
        return send(
          response,
          200,
          await host.loadLogin(sessionId, parse(browserLoadLoginSchema, await readJson(request, maxLoginBody))),
        );
      case 'POST site-state': {
        const { site } = parse(browserSiteStateRequestSchema, await readJson(request));
        return send(response, 200, await host.siteState(sessionId, site));
      }
      case 'POST input':
        await host.input(sessionId, parse(browserInputsSchema, await readJson(request)));
        return send(response, 204);
      case 'GET frames':
        return frames(sessionId, request, response);
      default:
        return send(response, 404, { error: 'invalid-request', message: 'Not found' });
    }
  }

  async function frames(sessionId: string, request: IncomingMessage, response: ServerResponse) {
    let unsubscribe: (() => void) | undefined;
    let started = false;
    // While a slow viewer catches up, only the newest state and frame wait, so nothing piles up in memory.
    const pending = new Map<string, string>();
    const write = (event: string, data: unknown) => {
      if (!started) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        started = true;
      }
      const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      if (response.writableNeedDrain) {
        if (!pending.size) response.once('drain', flush);
        pending.set(event, message);
        return;
      }
      response.write(message);
    };
    const flush = () => {
      const messages = [...pending.values()];
      pending.clear();
      if (!response.destroyed) for (const message of messages) response.write(message);
    };
    const heartbeat = setInterval(
      () => started && !response.writableNeedDrain && response.write(': keep-alive\n\n'),
      15_000,
    );
    const stop = () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    };
    request.on('close', stop);
    try {
      unsubscribe = await host.subscribe(sessionId, event =>
        event.type === 'frame' ? write('frame', event.frame) : write('state', event.state),
      );
      if (request.destroyed) stop();
    } catch (error) {
      stop();
      throw error;
    }
  }
}
