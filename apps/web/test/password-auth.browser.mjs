import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Screenshots go to PASSWORD_SCREENSHOTS when set, for reviewing the screens by eye.
const screenshots = process.env.PASSWORD_SCREENSHOTS;
const destination = '/acme/settings?tab=general';

function destinationPage() {
  return {
    name: 'password-destination',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== destination) return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<h1>Requested destination</h1>');
      });
    },
  };
}

// A small stand-in for the Better Auth routes the screens call.
async function mockAuth(context, options) {
  const users = new Map([['pat@example.test', 'correct horse battery']]);
  const calls = [];
  let wrongAttempts = 0;
  await context.route('**/v1/auth/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/v1/auth', '');
    const body = request.method() === 'POST' ? JSON.parse(request.postData() || '{}') : null;
    calls.push({ path, body });
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (path === '/get-session') return json(null);
    if (path === '/options') return json(options);
    if (path === '/sign-in/email') {
      if (wrongAttempts >= 2) return json({ error: 'rate-limit-exceeded' }, 429);
      if (users.get(body.email) === body.password) return json({ token: 'session', user: { email: body.email } });
      wrongAttempts++;
      return json({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }, 401);
    }
    if (path === '/sign-up/email') {
      if (users.has(body.email))
        return json({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', message: 'User already exists.' }, 422);
      users.set(body.email, body.password);
      return json({ token: 'session', user: { email: body.email } });
    }
    if (path === '/sign-in/magic-link') return json({ status: true });
    if (path === '/request-password-reset') return json({ status: true });
    if (path === '/reset-password')
      return body.token === 'good'
        ? json({ status: true })
        : json({ code: 'INVALID_TOKEN', message: 'Invalid token' }, 400);
    throw new Error(`Unexpected auth request: ${path}`);
  });
  return calls;
}

async function shot(page, name, colorScheme) {
  if (!screenshots) return;
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/${name}-${colorScheme}.png`, fullPage: true });
}

async function withServer(run) {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, plugins: [destinationPage()] });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    await run(`http://127.0.0.1:${server.httpServer.address().port}`, browser);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function open(browser, colorScheme, options) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    colorScheme,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const calls = options ? await mockAuth(context, options) : [];
  return { context, page, errors, calls };
}

test('without password sign-in the login page offers only email links and Google', { timeout: 120000 }, async () => {
  await withServer(async (origin, browser) => {
    const { context, page, errors, calls } = await open(browser, 'light', {
      turnstileSiteKey: null,
      google: true,
      magicLink: true,
    });
    await page.goto(`${origin}/login`);
    await page.getByText('We will email you a magic link to sign in.').waitFor();
    await page.getByRole('button', { name: 'Email me a sign-in link' }).waitFor();
    assert.equal(await page.getByLabel('Password').count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Forgot password?' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Log in' }).count(), 0);
    await page.goto(`${origin}/register?redirect=${encodeURIComponent(destination)}`);
    await page.getByRole('button', { name: 'Email me a sign-up link' }).waitFor();
    assert.equal(await page.getByLabel('Password').count(), 0);
    await page.goto(`${origin}/register`);
    await page.getByLabel('Workspace name', { exact: true }).fill('Acme Partners');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Create workspace with email' }).waitFor();
    assert.equal(await page.getByLabel('Password').count(), 0);
    await page.goto(`${origin}/login/forgot-password`);
    await page.getByText('This TulipFarm instance signs in with email links, not passwords.').waitFor();
    assert.equal(
      calls.some(call => call.path.includes('email') && call.path !== '/sign-in/magic-link'),
      false,
    );
    assert.deepEqual(errors, []);
    await context.close();
  });
});

test('sign-in methods without server credentials stay hidden', { timeout: 120000 }, async () => {
  await withServer(async (origin, browser) => {
    const google = { name: 'Continue with Google' };
    const emailLink = { name: 'Email me a sign-in link' };
    const cases = [
      {
        options: { google: false, magicLink: true },
        subtitle: 'We will email you a magic link to sign in.',
        google: 0,
        emailLink: 1,
      },
      {
        options: { google: true, magicLink: false },
        subtitle: 'Continue with your Google account.',
        google: 1,
        emailLink: 0,
      },
      {
        options: { emailPassword: true, google: false, magicLink: false },
        subtitle: 'Sign in with your email and password.',
        google: 0,
        emailLink: 0,
      },
    ];
    for (const expected of cases) {
      const { context, page, errors } = await open(browser, 'light', { turnstileSiteKey: null, ...expected.options });
      await page.goto(`${origin}/login`);
      await page.getByText(expected.subtitle).waitFor();
      assert.equal(await page.getByRole('button', google).count(), expected.google, JSON.stringify(expected));
      assert.equal(await page.getByRole('button', emailLink).count(), expected.emailLink, JSON.stringify(expected));
      assert.equal(await page.getByText('or', { exact: true }).count(), 0);
      if (expected.options.emailPassword) await page.getByRole('button', { name: 'Log in' }).waitFor();
      if (!expected.emailLink && !expected.options.emailPassword)
        assert.equal(await page.getByLabel('Email').count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
    }

    const { context, page, errors } = await open(browser, 'light', {
      turnstileSiteKey: null,
      google: false,
      magicLink: false,
    });
    await page.goto(`${origin}/login`);
    await page.getByText('No sign-in method is set up on this server.', { exact: false }).waitFor();
    await page.getByText('Sign-in is not set up on this server yet.').waitFor();
    assert.equal(await page.getByLabel('Email').count(), 0);
    assert.equal(await page.getByRole('button', google).count(), 0);
    await page.goto(`${origin}/register`);
    await page.getByText('No sign-in method is set up on this server.', { exact: false }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  });
});

test('password sign-in, sign-up, forgot and reset screens', { timeout: 240000 }, async () => {
  await withServer(async (origin, browser) => {
    for (const colorScheme of ['light', 'dark']) {
      const options = {
        turnstileSiteKey: null,
        emailPassword: true,
        passwordResetEmail: false,
        google: true,
        magicLink: true,
      };
      const { context, page, errors, calls } = await open(browser, colorScheme, options);
      const redirect = encodeURIComponent(destination);

      await page.goto(`${origin}/login?redirect=${redirect}`);
      await page.getByText('Use your password, or get a magic link by email.').waitFor();
      const password = page.getByLabel('Password');
      await password.waitFor();
      assert.equal(await password.getAttribute('autocomplete'), 'current-password');
      assert.equal(await page.getByRole('button', { name: 'Email me a sign-in link' }).count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Continue with Google' }).count(), 1);
      await shot(page, 'login', colorScheme);

      await page.getByLabel('Email', { exact: true }).fill('pat@example.test');
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.getByText('Enter your password.').waitFor();
      await password.fill('not the password');
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.getByText('The email or password is incorrect.').waitFor();
      await shot(page, 'login-wrong-password', colorScheme);
      await password.fill('still not it');
      await password.press('Enter');
      await page.waitForFunction(() => document.body.textContent.includes('incorrect'));
      await password.fill('correct horse battery');
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.getByText('Too many attempts. Please wait a few minutes and try again.').waitFor();
      assert.deepEqual(
        calls.filter(call => call.path === '/sign-in/email').map(call => call.body.password),
        ['not the password', 'still not it', 'correct horse battery'],
      );

      // The secondary button still sends a magic link and ignores the password field.
      await password.fill('');
      await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
      await page.getByText('Check your email').waitFor();
      assert.deepEqual(calls.find(call => call.path === '/sign-in/magic-link').body.email, 'pat@example.test');

      const fresh = await open(browser, colorScheme, options);
      await fresh.page.goto(`${origin}/login?redirect=${redirect}`);
      await fresh.page.getByLabel('Email', { exact: true }).fill('pat@example.test');
      await fresh.page.getByLabel('Password').fill('correct horse battery');
      await fresh.page.getByRole('button', { name: 'Log in' }).click();
      await fresh.page.waitForURL(`${origin}${destination}`);
      await fresh.page.getByRole('heading', { name: 'Requested destination' }).waitFor();
      assert.deepEqual(fresh.errors, []);
      await fresh.context.close();

      await page.goto(`${origin}/register?redirect=${redirect}`);
      await page.getByText('8 to 128 characters.').waitFor();
      assert.equal(await page.getByLabel('Password').getAttribute('autocomplete'), 'new-password');
      await page.getByLabel('Name').fill('Sam');
      await page.getByLabel('Email', { exact: true }).fill('pat@example.test');
      await page.getByLabel('Password').fill('short');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByText('Use at least 8 characters.').waitFor();
      await page.getByLabel('Password').fill('a long new password');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page
        .getByText('An account already exists for this address. Log in, or reset your password to add one.')
        .waitFor();
      await shot(page, 'register', colorScheme);
      await page.getByLabel('Email', { exact: true }).fill('sam@example.test');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.waitForURL(`${origin}${destination}`);
      assert.deepEqual(calls.findLast(call => call.path === '/sign-up/email').body, {
        email: 'sam@example.test',
        name: 'Sam',
        password: 'a long new password',
      });

      // Forgot password without an email transport points to the administrator.
      await page.goto(`${origin}/login?redirect=${redirect}`);
      await page.getByRole('link', { name: 'Forgot password?' }).click();
      await page.waitForURL(`${origin}/login/forgot-password?redirect=${redirect}`);
      await page.getByText('Ask your administrator for a reset link.').waitFor();
      await page.getByText('pnpm auth:reset-password you@company.com').waitFor();
      await shot(page, 'forgot-password-admin', colorScheme);
      await page.getByRole('link', { name: 'Back to login' }).click();
      await page.waitForURL(`${origin}/login?redirect=${redirect}`);

      await page.goto(`${origin}/login/reset-password?token=good`);
      await page.getByRole('heading', { name: 'Choose a new password' }).waitFor();
      await page.getByLabel('New password', { exact: true }).fill('my new password');
      await page.getByLabel('Confirm new password').fill('my other password');
      await page.getByRole('button', { name: 'Set new password' }).click();
      await page.getByText('The passwords do not match.').waitFor();
      await shot(page, 'reset-password', colorScheme);
      await page.getByLabel('Confirm new password').fill('my new password');
      await page.getByRole('button', { name: 'Set new password' }).click();
      await page.getByRole('heading', { name: 'Password updated' }).waitFor();
      assert.deepEqual(calls.findLast(call => call.path === '/reset-password').body, {
        newPassword: 'my new password',
        token: 'good',
      });
      await shot(page, 'reset-password-done', colorScheme);
      await page.getByRole('link', { name: 'Log in' }).first().click();
      await page.waitForURL(`${origin}/login?redirect=%2F`);

      await page.goto(`${origin}/login/reset-password?token=used`);
      await page.getByLabel('New password', { exact: true }).fill('my new password');
      await page.getByLabel('Confirm new password').fill('my new password');
      await page.getByRole('button', { name: 'Set new password' }).click();
      await page.getByText('This reset link has expired or was already used. Request a new one.').waitFor();
      await page.goto(`${origin}/login/reset-password`);
      await page.getByRole('heading', { name: 'This link is no longer valid' }).waitFor();
      await page.getByRole('link', { name: 'Request a new link' }).click();
      await page.waitForURL(`${origin}/login/forgot-password?redirect=%2F`);
      assert.deepEqual(errors, []);
      await context.close();

      // With an email transport, forgot password sends a link.
      const mail = await open(browser, colorScheme, { ...options, passwordResetEmail: true });
      await mail.page.goto(`${origin}/login/forgot-password`);
      await mail.page.getByRole('button', { name: 'Email me a reset link' }).click();
      await mail.page.getByText('Enter a valid email address.').waitFor();
      await mail.page.getByLabel('Email', { exact: true }).fill('pat@example.test');
      await shot(mail.page, 'forgot-password-email', colorScheme);
      await mail.page.getByRole('button', { name: 'Email me a reset link' }).click();
      await mail.page.getByText('Check your email').waitFor();
      assert.deepEqual(mail.calls.find(call => call.path === '/request-password-reset').body, {
        email: 'pat@example.test',
      });
      await shot(mail.page, 'forgot-password-sent', colorScheme);
      assert.deepEqual(mail.errors, []);
      await mail.context.close();
    }
  });
});

test('account settings change a password, or explain how to set one', { timeout: 180000 }, async () => {
  await withServer(async (origin, browser) => {
    for (const colorScheme of ['light', 'dark']) {
      const { context, page, errors } = await open(browser, colorScheme);
      await page.goto(`${origin}/memory-mock/settings/account?passwordScenario=credential`);
      await page.getByRole('button', { name: 'Change password' }).click();
      await page.getByRole('button', { name: 'Save password' }).click();
      await page.getByText('Enter your current password.').waitFor();
      await page.getByLabel('Current password').fill('wrong password');
      await page.getByLabel('New password', { exact: true }).fill('a better password');
      await page.getByLabel('Confirm new password').fill('a better password');
      await page.getByRole('button', { name: 'Save password' }).click();
      await page.getByText('The current password is incorrect.').waitFor();
      await page.getByRole('heading', { name: 'Profile' }).scrollIntoViewIfNeeded();
      await shot(page, 'account-change-password', colorScheme);
      await page.getByLabel('Current password').fill('current password');
      await page.getByRole('button', { name: 'Save password' }).click();
      await page.getByText('Password changed. Your other devices were signed out.').waitFor();
      assert.equal(await page.getByLabel('Current password').count(), 0);

      await page.goto(`${origin}/memory-mock/settings/account?passwordScenario=link`);
      await page.getByText('No password yet. Email yourself a reset link to set one.').waitFor();
      assert.equal(
        await page.getByRole('link', { name: 'Set a password' }).getAttribute('href'),
        '/login/forgot-password',
      );
      await shot(page, 'account-no-password', colorScheme);

      // Instances without password sign-in show no password row.
      await page.goto(`${origin}/memory-mock/settings/account`);
      await page.getByText('Sign-in methods', { exact: true }).waitFor();
      await page.waitForLoadState('networkidle');
      assert.equal(await page.getByText('Password', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
    }
  });
});
