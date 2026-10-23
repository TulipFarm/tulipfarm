import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeErrorEvent, routeErrorProperties } from '../src/lib/route-error-report.ts';

class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

test('route error reports classify the failure without its message', () => {
  assert.equal(routeErrorEvent, 'route_error_shown');
  assert.deepEqual(routeErrorProperties(new RequestError(502, 'Bad gateway for me@example.com'), false), {
    kind: 'request',
    status: 502,
    errorType: 'Error',
  });
  assert.deepEqual(routeErrorProperties(new TypeError('Failed to fetch https://api.example/x'), false), {
    kind: 'network',
    errorType: 'TypeError',
  });
  assert.deepEqual(routeErrorProperties(new TypeError('Importing a module script failed'), true), {
    kind: 'asset',
    errorType: 'TypeError',
  });
  assert.deepEqual(routeErrorProperties('secret text', false), { kind: 'other', errorType: 'Error' });
  const custom = new Error('x');
  custom.name = 'user@example.com';
  assert.deepEqual(routeErrorProperties(custom, false), { kind: 'other', errorType: 'Error' });
  assert.deepEqual(routeErrorProperties({ status: 200 }, false), { kind: 'other', errorType: 'Error' });
});
