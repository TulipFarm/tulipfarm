import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { chatDocumentSchema } from '@tulipfarm/conversations/rich-content';
import { execFileSync } from 'node:child_process';
import { createWorkspaceFixture, workspaceShellReads } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

const screenshots = process.env.CODE_FENCE_SCREENSHOTS;
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

async function openComposer(run, { project = false } = {}) {
  const { workspace, session } = createWorkspaceFixture();
  const projectFixture = {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Launch',
    instructions: '',
    revision: 1,
    archived: false,
    manager: true,
  };
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const browser = await chromium.launch(
    process.env.COMPOSER_CDP_PORT ? { args: [`--remote-debugging-port=${process.env.COMPOSER_CDP_PORT}`] } : {},
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let chat = null;
  let history = [];
  const sends = [];
  try {
    await page.route('**/v1/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      const shell = workspaceShellReads(workspace.id).find(([key]) => key === path);
      if (method === 'GET' && shell) return route.fulfill({ json: shell[1] });
      if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
      if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
      if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
      if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
      if (path === `/v1/workspaces/${workspace.slug}/last-used` && method === 'PUT')
        return route.fulfill({ status: 204 });
      if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
      if (path.endsWith('/credits')) return route.fulfill({ json: credits });
      if (path.endsWith('/bud'))
        return route.fulfill({
          json: {
            conversationId: null,
            onboarding: 'skipped',
            bubblesEnabled: false,
            snoozedUntil: null,
            nudge: null,
            preferences: [],
          },
        });
      if (path.endsWith('/recommendations'))
        return route.fulfill({ status: 503, json: { error: 'recommendations-unavailable' } });
      if (path.endsWith('/recommendations/events'))
        return route.fulfill({ status: 503, json: { error: 'recommendations-unavailable' } });
      if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
      if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
      if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
      if (path.endsWith('/projects')) return route.fulfill({ json: project ? [projectFixture] : [] });
      if (path.endsWith(`/projects/${projectFixture.id}`))
        return route.fulfill({ json: { project: projectFixture, members: [], files: [] } });
      if (path.endsWith('/google-workspace/operations/proposals'))
        return route.fulfill({ json: { proposals: [], nextCursor: null } });
      if (path.endsWith('/workspace-mcp/capabilities'))
        return route.fulfill({ status: 404, json: { error: 'not-found' } });
      if (path.endsWith('/candidates')) return route.fulfill({ json: [] });
      if (path.endsWith('/files/suggestions')) return route.fulfill({ json: { items: [], next: null } });
      if (path.endsWith('/conversations') && method === 'GET')
        return route.fulfill({ json: { chats: chat ? [chat] : [], nextCursor: null } });
      const conversation = /\/conversations\/([\w-]+)(\/.*)?$/.exec(path);
      if (conversation) {
        const [, id, rest = ''] = conversation;
        if (method === 'PUT' && !rest) {
          chat = {
            id,
            title: 'New chat',
            titleRevision: 0,
            titleManual: false,
            archived: false,
            activityAt: '2026-10-09T10:00:00.000000Z',
            createdAt: '2026-10-09T10:00:00.000000Z',
            projectId: request.postDataJSON().projectId ?? null,
          };
          return route.fulfill({ json: { id } });
        }
        if (method === 'PUT' && rest.startsWith('/messages/')) {
          const body = request.postDataJSON();
          sends.push(body);
          const messageId = rest.split('/').at(-1);
          history = [
            {
              id: messageId,
              sequence: 1,
              author: 'human',
              createdAt: '2026-10-09T10:00:01.000Z',
              parts: body.parts,
              turn: { id: '88888888-8888-4888-8888-888888888888', status: 'completed', generation: 0 },
              tools: [],
              calendarResults: [],
            },
          ];
          return route.fulfill({ json: { messageId, turnId: '88888888-8888-4888-8888-888888888888', sequence: 1 } });
        }
        if (method === 'GET' && rest === '/messages')
          return route.fulfill({ json: { messages: history, nextBefore: null, hasGitHubProposals: false } });
        if (method === 'GET' && !rest) return route.fulfill({ json: chat });
        if (method === 'GET') return route.fulfill({ json: [] });
      }
      throw new Error(`Unexpected API request ${method} ${path}`);
    });
    await page.goto(
      `${server.resolvedUrls.local[0]}${workspace.slug}${project ? `/projects/${projectFixture.id}` : ''}`,
    );
    const editor = page.getByRole('textbox', { name: 'Message' });
    await editor.click();
    await run({ page, editor, sends });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
}

async function send(page, editor) {
  const accepted = page.waitForResponse(
    response => response.request().method() === 'PUT' && response.url().includes('/messages/'),
  );
  await editor.press(`${modifier}+Enter`);
  await accepted;
  await page.waitForURL(/\/chat\//);
  await page.getByRole('list', { name: 'Messages' }).locator('pre code').waitFor();
}

const textPartContent = sends => {
  assert.equal(sends.length, 1, 'one message sent');
  const part = sends[0].parts.find(candidate => candidate.kind === 'text');
  return part.content.doc.content;
};

test(
  'typing a fence after Shift+Enter starts a code block with its language, sends it, and renders it in the transcript',
  { timeout: 120000 },
  async () => {
    await openComposer(async ({ page, editor, sends }) => {
      await editor.pressSequentially('hello');
      await editor.press('Shift+Enter');
      await editor.pressSequentially('```ts');
      if (screenshots) await page.screenshot({ path: `${screenshots}/fence-typed.png` });
      await editor.press('Enter');
      await editor.locator('pre').waitFor({ timeout: 2000 });
      await editor.pressSequentially('const total = 42;');
      await editor.press('Enter');
      await editor.pressSequentially('return total;');
      if (screenshots) await page.screenshot({ path: `${screenshots}/fence-code-block.png` });
      await send(page, editor);

      assert.deepEqual(textPartContent(sends), [
        { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
        {
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [{ type: 'text', text: 'const total = 42;\nreturn total;' }],
        },
        { type: 'paragraph' },
      ]);
      assert.equal(
        await page.getByRole('list', { name: 'Messages' }).locator('pre code').textContent(),
        'const total = 42;\nreturn total;',
      );
      if (screenshots) await page.screenshot({ path: `${screenshots}/fence-transcript.png` });
    });
  },
);

test(
  'typing a fence followed by a space at the start of the composer starts a plain code block',
  { timeout: 120000 },
  async () => {
    await openComposer(async ({ page, editor, sends }) => {
      await editor.pressSequentially('``` ');
      await editor.locator('pre').waitFor({ timeout: 2000 });
      await editor.pressSequentially('ls -la');
      await send(page, editor);
      assert.deepEqual(textPartContent(sends), [
        { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'ls -la' }] },
        { type: 'paragraph' },
      ]);
    });
  },
);

test(
  'a schema-rejected editor document keeps the composer mounted and disables sending',
  { timeout: 120000 },
  async () => {
    await openComposer(async ({ page, editor, sends }) => {
      await editor.fill('x'.repeat(140_000));

      await page
        .getByRole('alert')
        .getByText('This message has unsupported formatting. Remove it or use supported formatting before sending.')
        .waitFor({ timeout: 10000 });
      assert.equal(await page.getByRole('textbox', { name: 'Message' }).count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Send message' }).isDisabled(), true);
      assert.equal(sends.length, 0);
    });
  },
);

test(
  'pasting fenced Markdown creates a code block between the surrounding paragraphs',
  { timeout: 120000 },
  async () => {
    await openComposer(async ({ page, editor, sends }) => {
      await page.evaluate(() =>
        navigator.clipboard.writeText('Run this:\n```python\nprint("hi")\nprint("bye")\n```\nThen reply.'),
      );
      await editor.press(`${modifier}+v`);
      await editor.locator('pre').waitFor({ timeout: 2000 });
      if (screenshots) await page.screenshot({ path: `${screenshots}/fence-pasted.png` });
      await send(page, editor);
      assert.deepEqual(textPartContent(sends), [
        { type: 'paragraph', content: [{ type: 'text', text: 'Run this:' }] },
        {
          type: 'codeBlock',
          attrs: { language: 'python' },
          content: [{ type: 'text', text: 'print("hi")\nprint("bye")' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Then reply.' }] },
      ]);
    });
  },
);

async function sendRichText(page, editor, sends) {
  assert.equal(await editor.getAttribute('aria-invalid'), 'false');
  assert.equal(await page.getByRole('button', { name: 'Send message' }).isDisabled(), false);
  const accepted = page.waitForResponse(
    response => response.request().method() === 'PUT' && response.url().includes('/messages/'),
  );
  await editor.press(`${modifier}+Enter`);
  await accepted;
  await page.waitForURL(/\/chat\//);
  assert.equal(sends.length, 1);
  const part = sends[0].parts.find(candidate => candidate.kind === 'text');
  assert.equal(chatDocumentSchema.safeParse(part.content).success, true, JSON.stringify(part.content));
  return part;
}

test(
  'emails, domains, URLs and angle-bracket addresses remain sendable when typed or pasted',
  { timeout: 120000 },
  async () => {
    await openComposer(async ({ page, editor, sends }) => {
      const typed = [
        'someemail@gmai.com',
        'website.com',
        'https://example.com/a_(b)?q=one&next=two#part',
        'ftp://example.com/file',
        'tel:+15551234567',
      ];
      for (const value of typed) {
        await editor.pressSequentially(`${value} `);
        assert.equal(await editor.getAttribute('aria-invalid'), 'false', value);
      }
      const address = 'Mohit Jain <mayank.mohit@gmail.com>';
      await page.evaluate(text => navigator.clipboard.writeText(text), address);
      await editor.press(`${modifier}+v`);
      assert.equal(await editor.getAttribute('aria-invalid'), 'false');
      assert.equal(await editor.textContent(), `${typed.join(' ')} ${address}`);
      assert.equal(await editor.locator('a[href="mailto:someemail@gmai.com"]').count(), 1);
      assert.equal(await editor.locator('a[href="http://website.com"]').count(), 1);
      assert.equal(
        await editor.locator('a[href^="ftp:"], a[href^="tel:"]').count(),
        0,
        'other protocols remain readable text',
      );
      if (screenshots) {
        await page.screenshot({ path: `${screenshots}/links-sendable.png` });
        if (process.env.COMPOSER_CDP_PORT)
          execFileSync('agent-browser', [
            '--session',
            'composer-formatting',
            '--cdp',
            process.env.COMPOSER_CDP_PORT,
            'screenshot',
            `${screenshots}/links-agent-browser.png`,
          ]);
      }
      const part = await sendRichText(page, editor, sends);
      assert.equal(part.text, `${typed.join(' ')} ${address}`);
      const links = part.content.doc.content
        .flatMap(block => block.content ?? [])
        .flatMap(node => node.marks ?? [])
        .filter(mark => mark.type === 'link');
      assert.ok(links.length >= 3);
      assert.ok(links.every(mark => Object.keys(mark.attrs).join() === 'href'));
      const messages = page.getByRole('list', { name: 'Messages' });
      await messages.locator('a[href="mailto:someemail@gmai.com"]').first().waitFor();
      if (screenshots) await page.screenshot({ path: `${screenshots}/links-sent.png` });
    });
  },
);

test(
  'backspace, selection deletion, space and undo do not leave an old link on replacement text',
  { timeout: 120000 },
  async () => {
    await openComposer(async ({ page, editor, sends }) => {
      for (const deletion of ['backspace', 'selection']) {
        await editor.pressSequentially('someemail@gmai.com ');
        if (deletion === 'backspace') {
          for (let index = 0; index < 'someemail@gmai.com '.length; index++) await editor.press('Backspace');
        } else {
          await editor.press(`${modifier}+a`);
          await editor.press('Backspace');
        }
        assert.equal(await editor.textContent(), '');
        assert.equal(await page.getByRole('button', { name: 'Send message' }).isDisabled(), true);
        await editor.pressSequentially('as more');
        assert.equal(await editor.locator('a').count(), 0, deletion);
        assert.equal(await editor.getAttribute('aria-invalid'), 'false');
        await editor.press(`${modifier}+a`);
        await editor.press('Backspace');
      }
      await editor.pressSequentially('website.com ');
      await page.waitForTimeout(550); // Separate typing from deletion in ProseMirror's undo history.
      await editor.press(`${modifier}+a`);
      await editor.press('Backspace');
      await editor.press(`${modifier}+z`);
      assert.match(await editor.textContent(), /website\.com/);
      await editor.press(`${modifier}+Shift+z`);
      assert.equal(await editor.textContent(), '');
      await editor.pressSequentially('as');
      assert.equal(await editor.locator('a').count(), 0);
      if (screenshots) await page.screenshot({ path: `${screenshots}/retyped-plain-text.png` });
      const part = await sendRichText(page, editor, sends);
      assert.equal(part.text, 'as');
      assert.deepEqual(part.content.doc.content, [{ type: 'paragraph', content: [{ type: 'text', text: 'as' }] }]);
    });
  },
);

test(
  'rich paste preserves links, lists, headings, quotes and inline styles without leaking editor attributes',
  { timeout: 120000 },
  async () => {
    await openComposer(async ({ page, editor, sends }) => {
      await page.evaluate(() =>
        navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob(
              [
                '<h2>Contact</h2><p><strong><a href="mailto:hello@example.com" target="_blank" title="Email">Email us</a><br>Next line</strong> <em>italic</em> <s>strike</s> <code>code</code></p><ol start="3"><li><p>Third</p></li></ol><blockquote><p>Quote</p></blockquote><p><a href="javascript:alert(1)">unsafe link label</a></p>',
              ],
              { type: 'text/html' },
            ),
            'text/plain': new Blob(['Contact\nEmail us\nNext line'], { type: 'text/plain' }),
          }),
        ]),
      );
      await editor.press(`${modifier}+v`);
      assert.equal(await editor.locator('a[href^="javascript:"]').count(), 0);
      const part = await sendRichText(page, editor, sends);
      const blocks = part.content.doc.content;
      assert.ok(blocks.some(block => block.type === 'heading' && block.attrs.level === 2));
      assert.ok(blocks.some(block => block.type === 'orderedList' && block.attrs.start === 3));
      assert.ok(blocks.some(block => block.type === 'blockquote'));
      const inline = blocks.flatMap(block => block.content ?? []);
      assert.ok(inline.some(node => node.type === 'hardBreak'));
      for (const type of ['bold', 'italic', 'strike', 'code', 'link']) {
        assert.ok(
          inline.some(node => node.marks?.some(mark => mark.type === type)),
          type,
        );
      }
      assert.match(part.text, /unsafe link label/);
    });
  },
);

test('the project composer sends the same canonical email and link format', { timeout: 120000 }, async () => {
  await openComposer(
    async ({ page, editor, sends }) => {
      await editor.pressSequentially('hello@example.com https://example.com ');
      const part = await sendRichText(page, editor, sends);
      assert.equal(part.text, 'hello@example.com https://example.com ');
      const links = part.content.doc.content
        .flatMap(block => block.content ?? [])
        .flatMap(node => node.marks ?? [])
        .filter(mark => mark.type === 'link');
      assert.deepEqual(links, [
        { type: 'link', attrs: { href: 'mailto:hello@example.com' } },
        { type: 'link', attrs: { href: 'https://example.com' } },
      ]);
    },
    { project: true },
  );
});
