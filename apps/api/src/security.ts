import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { publicGuideOrigins } from './public-guide-config.ts';

export function securityServerOptions(): FastifyServerOptions {
  const proxy = z
    .enum(['direct', 'reverse-proxy', 'azure-container-apps'])
    .parse(process.env.API_PROXY_MODE ?? 'direct');
  // A proxy reuses idle upstream connections. If the API closes one first, the proxy can send the next
  // request into the closing socket and answer 502 itself, so the API never sees or logs it. Behind a
  // proxy, keep idle connections open longer than common proxy idle timeouts (AWS ALB and nginx: 60 s).
  // Direct clients keep the short timeout so idle sockets cannot pile up.
  const proxied = proxy !== 'direct';
  return {
    // The single trusted proxy appends the client address as the rightmost forwarded hop.
    trustProxy: proxied ? (_address, hop) => hop === 0 : false,
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

export function requestBoundaryError(error: unknown, reply: FastifyReply): boolean {
  if (error instanceof StorageUnavailableError && error.code === 'disabled') {
    reply.code(404).send({ error: 'not-found' });
    return true;
  }
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return false;
  const messages = new Map([
    [400, 'invalid-request'],
    [413, 'request-too-large'],
    [415, 'unsupported-media-type'],
    [429, 'rate-limit-exceeded'],
  ]);
  if (typeof error.statusCode !== 'number') return false;
  const message = messages.get(error.statusCode);
  if (!message) return false;
  reply.code(error.statusCode).send({ error: message });
  return true;
}

export function registerSecurity(app: FastifyInstance, webOrigin: string) {
  app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
    },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    // TLS and HTTPS redirects are owned by Container Apps ingress.
    hsts: false,
  });
  const max = z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .parse(process.env.API_RATE_LIMIT_PER_MINUTE ?? 300);
  app.register(rateLimit, { global: false, max, timeWindow: 60_000, cache: 10_000 });
  app.register(cors, {
    delegator: (request, callback) => {
      const guide = /^\/v1\/public\/guide\/(?:options|session|messages|signup)(?:\?|$)/.test(request.url);
      callback(null, {
        origin: guide ? publicGuideOrigins() : webOrigin,
        credentials: !guide,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['authorization', 'content-type', 'x-captcha-response', 'x-tulipfarm-expected-session'],
        exposedHeaders: ['Retry-After'],
        maxAge: 600,
        preflightContinue: true,
      });
    },
  });
  app.after(() => {
    const general = app.createRateLimit();
    const diagnostics = app.createRateLimit({ max: 6, timeWindow: 60_000 });
    app.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      const operation = request.routeOptions.schema?.operationId;
      if (operation === 'getLivenessV1') return;
      for (const limiter of operation === 'getHealthV1' ? [general, diagnostics] : [general]) {
        const result = await limiter(request);
        if (!result.isAllowed && result.isExceeded) {
          return reply.code(429).header('Retry-After', result.ttlInSeconds).send({ error: 'rate-limit-exceeded' });
        }
      }
      if (request.method === 'OPTIONS' && request.headers.origin && request.headers['access-control-request-method'])
        return reply.code(204).send();
    });
  });
  app.addHook('onRoute', route => {
    if (!route.schema || route.schema.hide) return;
    const error = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };
    route.schema.response = Object.assign(
      { 400: error, 413: error, 415: error, 429: error, 500: error, 503: error },
      route.schema.response,
    );
  });
  app.setErrorHandler((error, request, reply) => {
    if (requestBoundaryError(error, reply)) return;
    request.log.error({ err: error }, 'Request failed');
    return reply.code(500).send({ error: 'internal-server-error' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not-found' }));
}
