import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

test('controlled avatars preserve the approved designs without app integration', { timeout: 120_000 }, async () => {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    optimizeDeps: { entries: ['test/tulip-avatar-browser-fixture.tsx'] },
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { port: 0 },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'tulip-avatar-test-page',
        configureServer(server) {
          server.middlewares.use('/avatar-test', async (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end(
              await server.transformIndexHtml(
                '/avatar-test',
                '<html data-sprout-theme="tulipfarm"><head><title>Tulip avatars</title></head><body><div id="root"></div></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  await server.listen();
  const port = process.env.TULIP_AVATAR_CDP_PORT;
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', ...(port ? [`--remote-debugging-port=${port}`] : [])],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1152, height: 1000 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      const draws = CanvasRenderingContext2D.prototype.drawImage;
      window.avatarGraphics = { contexts: new Set(), frames: new Map(), deny: false, failures: [] };
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        if (kind === 'webgl2' && window.avatarGraphics.deny) return null;
        const context = getContext.call(this, kind, ...args);
        if (kind === 'webgl2' && context) window.avatarGraphics.contexts.add(this);
        return context;
      };
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        const frames = window.avatarGraphics.frames;
        frames.set(this.canvas, (frames.get(this.canvas) || 0) + 1);
        return draws.apply(this, args);
      };
    });
    await page.goto(`${server.resolvedUrls.local[0]}avatar-test`);
    await page.evaluate(async () => {
      const api = await import('/test/tulip-avatar-browser-fixture.tsx');
      const { React, createRoot, TulipAvatar } = api;
      let root = createRoot(document.querySelector('#root'));
      window.avatarTest = {
        api,
        render(items) {
          root.render(
            React.createElement(
              React.StrictMode,
              null,
              React.createElement(
                'main',
                { className: 'p-8' },
                React.createElement('h1', { className: 'text-2xl mb-6' }, 'Tulip avatars'),
                React.createElement(
                  'div',
                  { className: 'flex flex-wrap gap-6' },
                  ...items.map((item, index) =>
                    React.createElement(
                      'figure',
                      { key: index, className: 'flex flex-col items-center gap-2' },
                      React.createElement(TulipAvatar, {
                        ...item,
                        onError: error => window.avatarGraphics.failures.push(error.message),
                      }),
                      React.createElement(
                        'figcaption',
                        { className: 'text-sm' },
                        `${item.character || 'Bud'} / ${item.state || 'Idle'}`,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        },
        unmount() {
          root.unmount();
        },
        remount() {
          root = createRoot(document.querySelector('#root'));
        },
      };
      window.avatarTest.render([
        { name: 'Research agent', character: 'Bud', state: 'Working', color: 'Blue', size: 256, paused: true },
        { name: 'Welcome agent', character: 'Curl', state: 'Waving', color: 'Rose', size: 256, paused: true },
      ]);
    });
    const ready = count =>
      page.waitForFunction(count => document.querySelectorAll('[data-status="ready"]').length === count, count);
    const picture = index =>
      page
        .locator('[data-slot="tulip-avatar"] canvas')
        .nth(index)
        .evaluate(canvas => canvas.toDataURL());
    const frames = () => page.evaluate(() => [...window.avatarGraphics.frames.values()].reduce((a, b) => a + b, 0));
    await ready(2);
    assert.equal(await page.evaluate(() => window.avatarGraphics.contexts.size), 1);
    await page.getByRole('img', { name: 'Research agent, working' }).waitFor();
    const working = await picture(0);
    const other = await picture(1);
    const pausedFrames = await frames();
    await page.waitForTimeout(180);
    assert.equal(await frames(), pausedFrames, 'paused instances do not keep rendering');
    await page.evaluate(() =>
      window.avatarTest.render([
        {
          name: 'Research agent',
          character: 'Bud',
          state: 'Reading',
          color: 'Mint',
          size: 128,
          shape: 'square',
          paused: true,
        },
        { name: 'Welcome agent', character: 'Curl', state: 'Waving', color: 'Rose', size: 256, paused: true },
      ]),
    );
    await page.waitForFunction(before => document.querySelector('canvas[role="img"]').toDataURL() !== before, working);
    assert.equal(await picture(1), other, 'one avatar update leaves its sibling unchanged');
    assert.equal(
      await page
        .locator('[data-slot="tulip-avatar"]')
        .first()
        .evaluate(element => element.getBoundingClientRect().width),
      128,
    );
    assert.equal(await page.evaluate(() => window.avatarGraphics.contexts.size), 1);

    const geometry = await page.evaluate(() => {
      const { THREE, createAvatarModel, animateAvatar, disposeAvatarScene, tulipAvatarCharacters, tulipAvatarStates } =
        window.avatarTest.api;
      const results = [];
      for (const character of tulipAvatarCharacters) {
        const scene = new THREE.Scene();
        const model = createAvatarModel(scene, character, '#299fe9');
        if (model.hair.scale.x !== 0.9 || model.eyes.some(eye => eye.children[0].scale.x !== 1.2))
          throw new Error('Design proportions changed');
        model.head.traverse(object => {
          if (!object.layers.isEnabled(1)) throw new Error('Head missing portrait layer');
        });
        if (model.body.layers.isEnabled(1)) throw new Error('Body leaked into portrait');
        for (const state of tulipAvatarStates) {
          animateAvatar(model, state, 0, 1);
          const expected = {
            Thinking: 'thought',
            Solving: 'math',
            Listening: 'listening',
            Searching: 'search',
            Sleeping: 'sleep',
            Confused: 'confused',
            Celebrating: 'celebrate',
          };
          for (const [name, group] of Object.entries(model.indicators.groups)) {
            if (group.visible !== (expected[state] === name)) throw new Error(`Wrong ${state} indicator`);
          }
          if (model.portraitActions.keyboard.visible !== (state === 'Working'))
            throw new Error('Missing portrait keyboard');
          if (model.portraitActions.book.visible !== (state === 'Reading')) throw new Error('Missing portrait book');
        }
        animateAvatar(model, 'Solving', 1, 1);
        if (!model.idea.visible) throw new Error('Late solving bulb');
        results.push(model.hair.children.length);
        disposeAvatarScene(scene);
        if (scene.children.length) throw new Error('Scene resources retained');
      }
      return results;
    });
    assert.equal(geometry.length, 16);

    await page.evaluate(() => {
      const { tulipAvatarCharacters, tulipAvatarColors, tulipAvatarStates } = window.avatarTest.api;
      window.avatarTest.render(
        tulipAvatarCharacters.map((character, index) => ({
          name: character,
          character,
          color: Object.keys(tulipAvatarColors)[index % 12],
          state: tulipAvatarStates[(index + 2) % 14],
          size: 128,
          paused: true,
        })),
      );
    });
    await ready(16);
    const visiblePixels = await page.locator('canvas[role="img"]').evaluateAll(canvases =>
      canvases.map(canvas => {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++;
        return count;
      }),
    );
    assert.ok(
      visiblePixels.every(count => count > 1000),
      'every character must render actual pixels',
    );
    assert.equal(await page.evaluate(() => window.avatarGraphics.contexts.size), 1);
    const screenshot = process.env.TULIP_AVATAR_SCREENSHOT;
    if (screenshot) {
      if (port)
        execFileSync('agent-browser', ['--session', 'tulip-component', '--cdp', port, 'screenshot', screenshot]);
      else await page.screenshot({ path: screenshot });
    }

    await page.evaluate(() =>
      window.avatarTest.render([
        { character: 'Lotus', color: '#123abc', state: 'Celebrating', size: 256 },
        ...[24, 32, 40, 64].map(size => ({ character: 'Bud', state: 'Working', size, paused: true })),
      ]),
    );
    await ready(5);
    const start = await picture(0);
    await page.waitForFunction(before => document.querySelector('canvas[role="img"]').toDataURL() !== before, start);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(100);
    const frozen = await picture(0);
    const frozenFrames = await frames();
    await page.waitForTimeout(200);
    assert.equal(await picture(0), frozen);
    assert.equal(await frames(), frozenFrames);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(before => document.querySelector('canvas[role="img"]').toDataURL() !== before, frozen);

    await page.setViewportSize({ width: 375, height: 700 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.body.style.minHeight = '1800px';
    });
    await page.locator('canvas[role="img"]').first().hover();
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(() => scrollY > 100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(100);
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-mobile.png') });

    await page.evaluate(() => {
      window.avatarTest.unmount();
      window.avatarGraphics.deny = true;
      window.avatarTest.remount();
      window.avatarTest.render([{ name: 'Offline agent', size: 64 }]);
    });
    await page.getByRole('button', { name: 'Offline agent avatar unavailable. Retry avatar' }).waitFor();
    assert.ok(await page.evaluate(() => window.avatarGraphics.failures.length > 0));
    await page.evaluate(() => {
      window.avatarGraphics.deny = false;
    });
    await page.getByRole('button', { name: 'Offline agent avatar unavailable. Retry avatar' }).click();
    await ready(1);
    await page.evaluate(() => window.avatarTest.unmount());
    const finalFrames = await frames();
    await page.waitForTimeout(100);
    assert.equal(await frames(), finalFrames, 'unmount stops rendering');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});
