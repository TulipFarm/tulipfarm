import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { planDocumentMermaidConfig } from '@tulipfarm/plan-documents';

const require = createRequire(import.meta.url);
const blank = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

export type RendererOptions = {
  /** A Chromium or Chrome binary. Without one, Playwright's downloaded Chromium is used. */
  executablePath?: string | undefined;
  /** Runs Chromium in its own sandbox. Containers without user namespaces can't. */
  sandbox?: boolean;
  /** How long one diagram may take to draw. */
  diagramTimeoutMs?: number;
};

/**
 * Draws Mermaid diagrams and prints pages with a local Chromium. Pages never reach the network: every request a page
 * makes is aborted, apart from inline `data:` images.
 */
export async function createRenderer(options: RendererOptions = {}) {
  const [mermaid, purify] = await Promise.all([
    readFile(require.resolve('mermaid/dist/mermaid.min.js'), 'utf8'),
    readFile(require.resolve('dompurify/dist/purify.min.js'), 'utf8'),
  ]);
  const diagramTimeoutMs = options.diagramTimeoutMs ?? 15000;
  let browser: Promise<Browser> | undefined;

  const launch = () => {
    browser ??= chromium
      .launch({
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        chromiumSandbox: options.sandbox ?? false,
        args: ['--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-background-networking'],
      })
      .then(started => {
        started.on('disconnected', () => {
          browser = undefined;
        });
        return started;
      })
      .catch(error => {
        browser = undefined;
        throw error;
      });
    return browser;
  };

  async function isolated<T>(javaScriptEnabled: boolean, use: (context: BrowserContext) => Promise<T>) {
    const context = await (
      await launch()
    ).newContext({
      javaScriptEnabled,
      offline: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
      locale: 'en-GB',
      timezoneId: 'UTC',
      viewport: { width: 1024, height: 768 },
    });
    try {
      await context.route('**/*', route =>
        route.request().url().startsWith('data:') ? route.continue() : route.abort('blockedbyclient'),
      );
      return await use(context);
    } finally {
      await context.close();
    }
  }

  return {
    /**
     * Draws each diagram to a sanitized SVG. A diagram that fails, or takes too long, is null so the document shows its
     * fallback.
     */
    async diagrams(diagrams: readonly { key: string; source: string }[]): Promise<Record<string, string | null>> {
      if (!diagrams.length) return {};
      return isolated(true, async context => {
        const open = async () => {
          const page = await context.newPage();
          await page.setContent(blank);
          await page.addScriptTag({ content: purify });
          await page.addScriptTag({ content: mermaid });
          await page.evaluate(config => {
            const scope = globalThis as unknown as { mermaid: { initialize(config: unknown): void } };
            scope.mermaid.initialize({ ...config, htmlLabels: false });
          }, planDocumentMermaidConfig());
          return page;
        };
        let page = await open();
        const drawn: Record<string, string | null> = {};
        for (const [index, diagram] of diagrams.entries()) {
          let timer: NodeJS.Timeout | undefined;
          const timedOut = Symbol('timed-out');
          const result = await Promise.race([
            page.evaluate(
              async ({ id, source }) => {
                const scope = globalThis as unknown as {
                  mermaid: { render(id: string, source: string): Promise<{ svg: string }> };
                  DOMPurify: { sanitize(dirty: string, config: unknown): string };
                  document: { getElementById(id: string): { remove(): void } | null };
                };
                try {
                  const { svg } = await scope.mermaid.render(id, source);
                  const clean = scope.DOMPurify.sanitize(svg, {
                    USE_PROFILES: { svg: true, svgFilters: true },
                    ADD_TAGS: ['style'],
                  });
                  return clean.startsWith('<svg') ? clean : null;
                } catch {
                  return null;
                } finally {
                  scope.document.getElementById(id)?.remove();
                  scope.document.getElementById(`d${id}`)?.remove();
                }
              },
              { id: `plan-diagram-${index}`, source: diagram.source },
            ),
            new Promise<typeof timedOut>(resolve => {
              timer = setTimeout(() => resolve(timedOut), diagramTimeoutMs);
            }),
          ]).finally(() => clearTimeout(timer));
          if (result === timedOut) {
            // A diagram that hangs keeps its page busy, so the rest draw on a fresh one.
            await page.close().catch(() => undefined);
            page = await open();
            drawn[diagram.key] = null;
          } else drawn[diagram.key] = result;
        }
        return drawn;
      });
    },
    /** Prints a page as an A4 PDF with its scripts off. */
    async pdf(html: string): Promise<Uint8Array> {
      return isolated(false, async context => {
        const page = await context.newPage();
        await page.emulateMedia({ media: 'print' });
        await page.setContent(html, { waitUntil: 'load' });
        return page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, tagged: true, outline: true });
      });
    },
    async close() {
      const started = browser;
      browser = undefined;
      await (await started?.catch(() => undefined))?.close();
    },
  };
}

export type Renderer = Awaited<ReturnType<typeof createRenderer>>;
