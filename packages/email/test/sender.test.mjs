import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { createEmailSender, emailSenderConfigFromEnv, emailSenderConfigured } from '../src/sender.ts';

const rendered = { subject: 'Sign in', html: '<p>Hello</p>', text: 'Hello' };
const smtpEnv = { EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.test', SMTP_FROM_ADDRESS: 'noreply@example.test' };

test('unset provider keeps ACS when its connection string is present', () => {
  const env = {
    ACS_CONNECTION_STRING: 'endpoint=https://acs.test/;accesskey=fixture',
    ACS_SENDER_ADDRESS: 'DoNotReply@example.test',
    SMTP_HOST: 'ignored.test',
  };
  assert.deepEqual(emailSenderConfigFromEnv(env), {
    provider: 'acs',
    connectionString: env.ACS_CONNECTION_STRING,
    senderAddress: env.ACS_SENDER_ADDRESS,
  });
  assert.throws(() => emailSenderConfigFromEnv({ ACS_CONNECTION_STRING: 'x' }), {
    message: 'ACS_CONNECTION_STRING and ACS_SENDER_ADDRESS must be set',
  });
  assert.throws(() => emailSenderConfigFromEnv({ EMAIL_PROVIDER: 'acs' }), {
    message: 'ACS_CONNECTION_STRING and ACS_SENDER_ADDRESS must be set',
  });
});

test('SMTP settings default to STARTTLS on 587 and implicit TLS on 465', () => {
  assert.deepEqual(emailSenderConfigFromEnv(smtpEnv), {
    provider: 'smtp',
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    requireTLS: true,
    senderAddress: 'noreply@example.test',
  });
  assert.deepEqual(emailSenderConfigFromEnv({ SMTP_HOST: 'h.test', SMTP_FROM_ADDRESS: 'a@b.test', SMTP_PORT: '465' }), {
    provider: 'smtp',
    host: 'h.test',
    port: 465,
    secure: true,
    requireTLS: true,
    senderAddress: 'a@b.test',
  });
  assert.deepEqual(emailSenderConfigFromEnv({ ...smtpEnv, SMTP_SECURE: 'true' }).port, 465);
  assert.deepEqual(
    emailSenderConfigFromEnv({
      ...smtpEnv,
      SMTP_PORT: '1025',
      SMTP_REQUIRE_TLS: 'false',
      SMTP_USER: 'u',
      SMTP_PASSWORD: 'p',
    }),
    {
      provider: 'smtp',
      host: 'smtp.example.test',
      port: 1025,
      secure: false,
      requireTLS: false,
      auth: { user: 'u', pass: 'p' },
      senderAddress: 'noreply@example.test',
    },
  );
});

test('invalid email settings fail without echoing values', () => {
  for (const [change, message] of [
    [{ EMAIL_PROVIDER: 'sendgrid' }, 'EMAIL_PROVIDER must be one of: acs, smtp'],
    [{ SMTP_HOST: undefined }, 'SMTP_HOST and SMTP_FROM_ADDRESS must be set'],
    [{ SMTP_FROM_ADDRESS: 'Name <a@b.test>' }, 'SMTP_FROM_ADDRESS must be a single email address'],
    [{ SMTP_FROM_ADDRESS: 'a@b.test\r\nBcc: c@d.test' }, 'SMTP_FROM_ADDRESS must be a single email address'],
    [{ SMTP_PORT: '70000' }, 'SMTP_PORT must be a TCP port'],
    [{ SMTP_SECURE: 'yes' }, 'SMTP_SECURE must be true or false'],
    [{ SMTP_REQUIRE_TLS: '0' }, 'SMTP_REQUIRE_TLS must be true or false'],
    [{ SMTP_USER: 'secret-user' }, 'SMTP_USER and SMTP_PASSWORD must be set together'],
  ])
    assert.throws(() => emailSenderConfigFromEnv({ ...smtpEnv, ...change }), { message });
  assert.throws(() => emailSenderConfigFromEnv({}), /Email is not configured/);
});

test('any provider setting counts as configured email', () => {
  assert.equal(emailSenderConfigured({}), false);
  for (const env of [{ EMAIL_PROVIDER: 'smtp' }, { SMTP_HOST: 'h' }, { ACS_CONNECTION_STRING: 'x' }])
    assert.equal(emailSenderConfigured(env), true);
});

async function fakeSmtpServer({ rejectRecipient = false } = {}) {
  const messages = [];
  let starttls = false;
  const server = createServer(socket => {
    let data = false;
    let buffer = '';
    let current = { auth: null, from: null, to: [], body: '' };
    const reply = line => socket.write(`${line}\r\n`);
    reply('220 fake.test ESMTP');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') {
            data = false;
            messages.push(current);
            current = { auth: current.auth, from: null, to: [], body: '' };
            reply('250 2.0.0 queued as fake-id');
          } else current.body += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          socket.write('250-fake.test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        } else if (verb === 'AUTH') {
          current.auth = Buffer.from(line.split(' ')[2], 'base64').toString('utf8').split('\0').slice(1);
          reply('235 2.7.0 ok');
        } else if (verb === 'MAIL') {
          current.from = line.match(/<(.*)>/)[1];
          reply('250 ok');
        } else if (verb === 'RCPT') {
          if (rejectRecipient) reply('550 5.1.1 no such user');
          else {
            current.to.push(line.match(/<(.*)>/)[1]);
            reply('250 ok');
          }
        } else if (verb === 'DATA') {
          data = true;
          reply('354 go');
        } else if (line.toUpperCase() === 'STARTTLS') {
          starttls = true;
          reply('502 5.5.1 not supported');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    messages,
    starttls: () => starttls,
    port: server.address().port,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('SMTP adapter delivers subject, HTML and text through a real SMTP exchange', async () => {
  const server = await fakeSmtpServer();
  try {
    const config = emailSenderConfigFromEnv({
      ...smtpEnv,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(server.port),
      SMTP_REQUIRE_TLS: 'false',
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'fixture-password',
    });
    const id = await createEmailSender(config)('member@example.test', rendered);
    assert.match(id, /^<.+@example\.test>$/);
    assert.equal(server.messages.length, 1);
    const [message] = server.messages;
    assert.deepEqual(message.auth, ['mailer', 'fixture-password']);
    assert.equal(message.from, 'noreply@example.test');
    assert.deepEqual(message.to, ['member@example.test']);
    assert.match(message.body, /^Subject: Sign in$/m);
    assert.match(message.body, /Content-Type: text\/plain/);
    assert.match(message.body, /Content-Type: text\/html/);
  } finally {
    await server.close();
  }
});

test('SMTP adapter fails when the server rejects the recipient', async () => {
  const server = await fakeSmtpServer({ rejectRecipient: true });
  try {
    const config = emailSenderConfigFromEnv({
      ...smtpEnv,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(server.port),
      SMTP_REQUIRE_TLS: 'false',
    });
    await assert.rejects(createEmailSender(config)('missing@example.test', rendered));
    assert.equal(server.messages.length, 0);
  } finally {
    await server.close();
  }
});

test('SMTP adapter refuses a server without STARTTLS by default', async () => {
  const server = await fakeSmtpServer();
  try {
    const config = emailSenderConfigFromEnv({ ...smtpEnv, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port) });
    await assert.rejects(createEmailSender(config)('member@example.test', rendered));
    assert.equal(server.starttls(), true);
    assert.equal(server.messages.length, 0);
  } finally {
    await server.close();
  }
});
