import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderEmail } from '../dist/emails.js';

test('the password reset email links to the reset page and states its expiry', async () => {
  const url = 'https://app.example.test/login/reset-password?token=fixture-token';
  const email = await renderEmail({
    template: 'password-reset',
    props: { email: 'pat@example.test', url, expiresInMinutes: 60 },
  });
  assert.equal(email.subject, 'Reset your TulipFarm password');
  assert.ok(email.html.includes(`href="${url.replace('&', '&amp;')}"`));
  assert.match(email.text, /fixture-token/);
  assert.match(email.text, /pat@example\.test/);
  assert.match(email.text, /60 minutes|1 hour/);
});
