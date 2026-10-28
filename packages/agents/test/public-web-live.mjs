import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPublicText } from '../src/web-fetch.ts';

test(
  'requested GitHub articles return content through the configured Huntsman service',
  { skip: !process.env.HUNTSMAN_ENDPOINT, timeout: 60000 },
  async t => {
    const articles = [
      ['https://github.blog/ai-and-ml/github-copilot/reviewbench-an-open-benchmark-for-ai-code-review/', /ReviewBench/],
      [
        'https://github.blog/news-insights/policy-news-and-insights/developer-policy-update-transparency-state-policy-and-whats-ahead/',
        /1201/,
      ],
      [
        'https://github.blog/news-insights/company-news/10-technical-talks-im-excited-about-at-github-universe-2026/',
        /Lessons from building tech in a low-connectivity community/,
      ],
      [
        'https://github.blog/ai-and-ml/ai-is-rewriting-the-developer-career-ladder-heres-how-to-stand-out/',
        /career|skills/i,
      ],
    ];
    const pending = articles.values();
    const started = performance.now();
    await Promise.all(
      [1, 2].map(async () => {
        for (const [url, content] of pending) {
          const start = performance.now();
          const result = await fetchPublicText(url);
          assert.equal(result.status, 'success', url);
          assert.equal(result.pages[0].url, url);
          assert.match(result.pages[0].text, content);
          assert.ok(result.pages[0].text.length > 2000, url);
          t.diagnostic(
            JSON.stringify({ url, ms: Math.round(performance.now() - start), characters: result.pages[0].text.length }),
          );
        }
      }),
    );
    t.diagnostic(`Four-page retrieval total: ${Math.round(performance.now() - started)} ms`);
  },
);
