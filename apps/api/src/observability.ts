import type { FastifyInstance, FastifyRequest } from 'fastify';
import { captureException, startHttp, telemetryErrorCode, withTelemetryContext } from '@tulipfarm/observability';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Keep this route's trace regardless of the sample ratio, such as a send that starts a chat reply. */
    alwaysSampleTrace?: boolean;
  }
}

export function registerObservability(app: FastifyInstance) {
  // Route error handlers turn known errors into 4xx, so only errors that end as 5xx are reported.
  const errors = new WeakMap<FastifyRequest, unknown>();
  const codes = new WeakMap<FastifyRequest, string>();
  app.addHook('onRequest', (request, reply, done) => {
    const telemetry = startHttp(request.method, request.routeOptions.url ?? 'unmatched', {
      alwaysSample: request.routeOptions.config?.alwaysSampleTrace === true,
    });
    reply.raw.once('finish', () => {
      telemetry.finish(reply.statusCode, false, codes.get(request), errors.get(request));
      if (reply.statusCode >= 500 && errors.has(request)) captureException(errors.get(request));
    });
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) telemetry.finish(499, true);
    });
    withTelemetryContext(telemetry.context, done);
  });
  app.addHook('onError', (request, _reply, error, done) => {
    errors.set(request, error);
    const code = telemetryErrorCode(error.code);
    if (code) codes.set(request, code);
    done();
  });
  app.addHook('preSerialization', (request, reply, payload, done) => {
    if (reply.statusCode >= 400 && typeof payload === 'object' && payload !== null) {
      const code =
        telemetryErrorCode('error' in payload ? payload.error : undefined) ??
        telemetryErrorCode('code' in payload ? payload.code : undefined);
      if (code) codes.set(request, code);
    }
    done(null, payload);
  });
}
