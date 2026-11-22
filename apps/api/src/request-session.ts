import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import { observeStep } from '@tulipfarm/observability';

type SessionReader<T> = { api: { getSession: (input: { headers: Headers }) => Promise<T> } };

const sessions = new WeakMap<FastifyRequest, Promise<unknown>>();

/**
 * Reads the request's sign-in session once and shares it with every hook and handler of that request. A check that
 * must see a session revoked while a long request runs, such as a stream's recheck, calls `getSession` directly.
 */
export function requestSession<T>(request: FastifyRequest, auth: SessionReader<T>): Promise<T> {
  let session = sessions.get(request) as Promise<T> | undefined;
  if (!session) {
    session = observeStep('auth.session.get', () => auth.api.getSession({ headers: fromNodeHeaders(request.headers) }));
    sessions.set(request, session);
    // A failed read is not cached, so a later hook retries it instead of reusing the error.
    session.catch(() => sessions.delete(request));
  }
  return session;
}
