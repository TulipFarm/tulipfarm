import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderEmail } from '../dist/emails.js';

const url = 'https://app.example.test/acme/settings/usage';
const render = (level, available) =>
  renderEmail({
    template: 'credit-alert',
    props: { level, workspaceName: 'Acme', available, granted: 1000, grace: 100, url },
  });

test('credit alert emails state the balance, grace and what stops, and link to usage', async () => {
  const low = await render('low', 90);
  assert.equal(low.subject, 'Acme has used 90% of its credits');
  assert.ok(low.html.includes(`href="${url}"`));
  assert.match(low.text, /90 credits of 1,000 credits granted/);
  assert.match(low.text, /100 of 100 credits left/);

  const grace = await render('grace', -40);
  assert.equal(grace.subject, 'Acme is out of credits and running on grace');
  assert.match(grace.text, /-40 credits/);
  assert.match(grace.text, /60 of 100 credits left/);
  assert.match(grace.text, /model calls, agent runs and sandboxes pause/);

  const stopped = await render('stopped', -100);
  assert.equal(stopped.subject, 'Work is paused in Acme: out of credits');
  assert.match(stopped.text, /0 of 100 credits left/);
  assert.match(stopped.text, /Model calls, agent runs and sandboxes are paused until you add credits/);
});

test('with a support address, credit alert emails ask admins to write to it', async () => {
  const { html, text } = await renderEmail({
    template: 'credit-alert',
    props: {
      level: 'stopped',
      workspaceName: 'Acme',
      available: 0,
      granted: 1000,
      grace: null,
      url,
      supportEmail: 'help@example.test',
    },
  });
  assert.ok(html.includes('href="mailto:help@example.test?subject=Add%20credits%3A%20Acme"'));
  assert.match(text, /Contact us to add credits/);
  assert.match(text, /To add credits, email help@example.test/);
});
