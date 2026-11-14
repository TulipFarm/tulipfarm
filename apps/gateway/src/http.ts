import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { captureException, startHttp, telemetryErrorCode, withTelemetryContext } from '@tulipfarm/observability';
import { StorageUnavailableError, transientStorageError, withCallerSignal } from '@tulipfarm/workspace-storage/runtime';

export function gatewayServerOptions(env: NodeJS.ProcessEnv): FastifyServerOptions {
  const mode = z.enum(['direct', 'reverse-proxy', 'cloudfront']).parse(env.GATEWAY_PROXY_MODE ?? 'direct');
  const proxied = mode !== 'direct';
  // Each trusted proxy appends the address it received from as the rightmost forwarded hop. Behind CloudFront and a load
  // balancer, the balancer appends the CloudFront edge and CloudFront appends the client, so the client is the second
  // hop from the right. Anything further left is whatever the client sent and is never trusted.
  const trustedHops = { direct: 0, 'reverse-proxy': 1, cloudfront: 2 }[mode];
  // Behind a load balancer, idle connections outlive its idle timeout (AWS ALB: 60 s) so it never reuses a socket the
  // gateway is closing.
  return {
    trustProxy: proxied ? (_address, hop) => hop < trustedHops : false,
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
    connectionTimeout: proxied ? 70_000 : 60_000,
    keepAliveTimeout: proxied ? 65_000 : 5_000,
    maxRequestsPerSocket: 1_000,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    requestIdHeader: false,
  };
}

export function registerObservability(app: FastifyInstance) {
  const errors = new WeakMap<FastifyRequest, unknown>();
  const codes = new WeakMap<FastifyRequest, string>();
  app.addHook('onRequest', (request, reply, done) => {
    const telemetry = startHttp(request.method, request.routeOptions.url ?? 'unmatched');
    reply.raw.once('finish', () => {
      telemetry.finish(reply.statusCode, false, codes.get(request), errors.get(request));
      if (reply.statusCode >= 500 && errors.has(request)) captureException(errors.get(request));
    });
    // A client that leaves frees its place in the workspace storage queue.
    const sender = new AbortController();
    reply.raw.once('close', () => {
      if (reply.raw.writableFinished) return;
      telemetry.finish(499, true);
      sender.abort();
    });
    withTelemetryContext(telemetry.context, () => withCallerSignal(sender.signal, done));
  });
  app.addHook('onError', (request, _reply, error, done) => {
    errors.set(request, error);
    const code = telemetryErrorCode(error.code);
    if (code) codes.set(request, code);
    done();
  });
  app.addHook('preSerialization', (request, reply, payload, done) => {
    if (reply.statusCode >= 400 && typeof payload === 'object' && payload !== null && 'error' in payload) {
      const code = telemetryErrorCode(payload.error);
      if (code) codes.set(request, code);
    }
    done(null, payload);
  });
}

const workspaceUpdatingRetrySeconds = 5;
const refusedCodes = new Set(['40001', '40P01', '55P03', '57014', '57P03', '08001', 'ECONNREFUSED']);
const statusMessages = new Map([
  [400, 'invalid-request'],
  [413, 'request-too-large'],
  [415, 'unsupported-media-type'],
  [429, 'rate-limit-exceeded'],
]);

function refusedBeforeChange(error: unknown) {
  if (error instanceof StorageUnavailableError || !transientStorageError(error)) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (typeof code === 'string' && refusedCodes.has(code)) || message === 'timeout exceeded when trying to connect';
}

/**
 * Answers errors that the client can act on: a workspace still taking migrations or a storage refusal that is safe to
 * retry, a disabled workspace, and malformed or rate limited requests. Returns false for every other error.
 */
export function requestBoundaryError(error: unknown, reply: FastifyReply): boolean {
  if (error instanceof StorageUnavailableError && error.code === 'updating') {
    reply.code(503).header('Retry-After', workspaceUpdatingRetrySeconds).send({ error: 'workspace-updating' });
    return true;
  }
  if (error instanceof StorageUnavailableError && error.code === 'disabled') {
    reply.code(404).send({ error: 'not-found' });
    return true;
  }
  if (refusedBeforeChange(error)) {
    reply.code(503).header('Retry-After', '1').send({ error: 'temporarily-unavailable' });
    return true;
  }
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return false;
  if (typeof error.statusCode !== 'number') return false;
  const message = statusMessages.get(error.statusCode);
  if (!message) return false;
  reply.code(error.statusCode).send({ error: message });
  return true;
}
