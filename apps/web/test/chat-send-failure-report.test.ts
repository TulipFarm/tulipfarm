import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatSendFailedEvent, chatSendFailureProperties } from '../src/features/chat/send-failure-report.ts';

class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

test('a message left not sent is reported by reason, status and code only', () => {
  assert.equal(chatSendFailedEvent, 'chat_send_failed');
  const refused = new RequestError(403, 'access-denied', 'You cannot post in Acme Payroll');
  assert.deepEqual(chatSendFailureProperties({ kind: 'rejected', status: 403 }, refused), {
    reason: 'rejected',
    status: 403,
    code: 'access-denied',
  });
  assert.deepEqual(chatSendFailureProperties({ kind: 'rejected', status: 413 }), { reason: 'rejected', status: 413 });
  const unavailable = new RequestError(503, 'workspace-updating', 'Updating');
  assert.deepEqual(chatSendFailureProperties({ kind: 'uncertain', offline: false, updating: true }, unavailable), {
    reason: 'updating',
    status: 503,
    code: 'workspace-updating',
  });
  assert.deepEqual(
    chatSendFailureProperties({ kind: 'uncertain', offline: false, unsent: true }, new RequestError(502, '', 'x')),
    { reason: 'unsent', status: 502 },
  );
  assert.deepEqual(chatSendFailureProperties({ kind: 'uncertain', offline: true }), { reason: 'offline' });
  assert.deepEqual(
    chatSendFailureProperties({ kind: 'uncertain', offline: false }, new TypeError('Failed to fetch https://x/y')),
    { reason: 'uncertain' },
  );
});

test('error text, user data and odd statuses never reach the report', () => {
  const leaky = new RequestError(400, 'Message "pay me@example.com" was refused', 'secret');
  assert.deepEqual(chatSendFailureProperties({ kind: 'rejected', status: 400 }, leaky), {
    reason: 'rejected',
    status: 400,
  });
  assert.deepEqual(chatSendFailureProperties({ kind: 'uncertain', offline: false }, { status: 200, code: 7 }), {
    reason: 'uncertain',
  });
  assert.deepEqual(chatSendFailureProperties({ kind: 'uncertain', offline: false }, 'me@example.com'), {
    reason: 'uncertain',
  });
});
