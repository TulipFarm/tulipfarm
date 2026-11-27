import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkAutonomousWritePolicy,
  googleAutonomousWriteKinds,
  googleAutonomousWritePolicySchema,
} from '../src/lifecycle-contracts.ts';

const sendTo = (to, extra = {}) => ({
  kind: 'gmail.messages.send',
  message: {
    to,
    subject: 'Verification',
    body: 'Hello',
    ...extra,
  },
});

const calendarEvent = (kind, attendees) => ({
  kind,
  calendarId: 'primary',
  event: {
    summary: 'Demo',
    start: { dateTime: '2026-05-01T15:00:00Z' },
    end: { dateTime: '2026-05-01T15:30:00Z' },
    ...(attendees ? { attendees: attendees.map(email => ({ email })) } : {}),
  },
});

test('googleAutonomousWritePolicySchema validates allowed operation kinds and bounds', () => {
  const parsed = googleAutonomousWritePolicySchema.parse({
    allowedOperations: ['gmail.messages.send', 'calendar.events.create'],
    allowedRecipients: ['verify@example.com'],
  });
  assert.deepEqual(parsed.allowedOperations, ['gmail.messages.send', 'calendar.events.create']);
  assert.deepEqual(parsed.allowedRecipients, ['verify@example.com']);
  assert.equal(googleAutonomousWriteKinds.includes('gmail.messages.send'), true);

  assert.throws(() => googleAutonomousWritePolicySchema.parse({ allowedOperations: [] }));
  assert.throws(() => googleAutonomousWritePolicySchema.parse({ allowedOperations: ['gmail.messages.trash'] }));
});

test('checkAutonomousWritePolicy enforces exact email allowlist with case and angle-bracket normalization', () => {
  const policy = {
    allowedOperations: ['gmail.messages.send'],
    allowedRecipients: ['verify@example.com'],
  };

  assert.deepEqual(checkAutonomousWritePolicy(sendTo(['verify@example.com']), policy), { allowed: true });
  assert.deepEqual(checkAutonomousWritePolicy(sendTo(['Verification Bot <VERIFY@EXAMPLE.COM>']), policy), {
    allowed: true,
  });
  assert.deepEqual(checkAutonomousWritePolicy(sendTo(['customer@other.com']), policy), {
    allowed: false,
    reason: 'recipient-not-allowed',
    blockedRecipients: ['customer@other.com'],
  });
});

test('checkAutonomousWritePolicy enforces domain allowlist and blocks lookalike domains', () => {
  const policy = {
    allowedOperations: ['gmail.messages.send', 'calendar.events.create'],
    allowedRecipients: ['@example.com'],
  };

  assert.deepEqual(checkAutonomousWritePolicy(sendTo(['verify@example.com', 'team@example.com']), policy), {
    allowed: true,
  });
  assert.deepEqual(checkAutonomousWritePolicy(sendTo(['verify@evil-example.com']), policy), {
    allowed: false,
    reason: 'recipient-not-allowed',
    blockedRecipients: ['verify@evil-example.com'],
  });
  assert.deepEqual(
    checkAutonomousWritePolicy(calendarEvent('calendar.events.create', ['founder1@example.com']), policy),
    {
      allowed: true,
    },
  );
  assert.deepEqual(
    checkAutonomousWritePolicy(
      calendarEvent('calendar.events.create', ['founder1@example.com', 'guest@other.com']),
      policy,
    ),
    {
      allowed: false,
      reason: 'recipient-not-allowed',
      blockedRecipients: ['guest@other.com'],
    },
  );
});

test('checkAutonomousWritePolicy inspects to, cc, bcc, drafts, and calendar update attendees', () => {
  const policy = {
    allowedOperations: [
      'gmail.messages.send',
      'gmail.drafts.create',
      'gmail.drafts.update',
      'gmail.drafts.send',
      'calendar.events.update',
    ],
    allowedRecipients: ['verify@example.com'],
  };

  assert.deepEqual(
    checkAutonomousWritePolicy(
      sendTo(['verify@example.com'], { cc: ['cc@other.com'], bcc: ['bcc@other.com'] }),
      policy,
    ),
    {
      allowed: false,
      reason: 'recipient-not-allowed',
      blockedRecipients: ['cc@other.com', 'bcc@other.com'],
    },
  );

  assert.deepEqual(
    checkAutonomousWritePolicy(
      {
        kind: 'gmail.drafts.create',
        message: { to: ['verify@example.com'], cc: ['leak@other.com'], subject: 'Hi', body: 'Body' },
      },
      policy,
    ),
    {
      allowed: false,
      reason: 'recipient-not-allowed',
      blockedRecipients: ['leak@other.com'],
    },
  );

  assert.deepEqual(
    checkAutonomousWritePolicy(
      {
        kind: 'gmail.drafts.send',
        draftId: 'draft-1',
        message: { to: ['verify@example.com'], bcc: ['sneaky@other.com'], subject: 'Hi', body: 'Body' },
      },
      policy,
    ),
    {
      allowed: false,
      reason: 'recipient-not-allowed',
      blockedRecipients: ['sneaky@other.com'],
    },
  );

  assert.deepEqual(
    checkAutonomousWritePolicy(
      {
        kind: 'calendar.events.update',
        calendarId: 'primary',
        eventId: 'evt-1',
        event: {
          summary: 'Updated',
          attendees: [{ email: 'verify@example.com' }, { email: 'external@other.com' }],
        },
      },
      policy,
    ),
    {
      allowed: false,
      reason: 'recipient-not-allowed',
      blockedRecipients: ['external@other.com'],
    },
  );
});

test('checkAutonomousWritePolicy handles omitted vs empty allowedRecipients and disallowed operation kinds', () => {
  assert.deepEqual(
    checkAutonomousWritePolicy(sendTo(['anyone@other.com']), {
      allowedOperations: ['gmail.messages.send'],
    }),
    { allowed: true },
  );

  assert.deepEqual(
    checkAutonomousWritePolicy(sendTo(['verify@example.com']), {
      allowedOperations: ['gmail.messages.send'],
      allowedRecipients: [],
    }),
    {
      allowed: false,
      reason: 'recipient-not-allowed',
      blockedRecipients: ['verify@example.com'],
    },
  );

  assert.deepEqual(
    checkAutonomousWritePolicy(calendarEvent('calendar.events.create', ['verify@example.com']), {
      allowedOperations: ['gmail.messages.send'],
      allowedRecipients: ['verify@example.com'],
    }),
    {
      allowed: false,
      reason: 'operation-not-allowed',
    },
  );

  assert.deepEqual(
    checkAutonomousWritePolicy(
      { kind: 'gmail.messages.trash', messageId: 'msg-1' },
      { allowedOperations: ['gmail.messages.send'] },
    ),
    {
      allowed: false,
      reason: 'operation-not-allowed',
    },
  );
});
