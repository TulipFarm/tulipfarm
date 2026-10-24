import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkNotice, messageLinks, readMessageLinks } from '../src/links.ts';

test('message links are https only, in order, deduped and capped at five', () => {
  const text = [
    'See https://example.com/a.png, and (https://en.wikipedia.org/wiki/Tulip_(flower)).',
    'Again https://example.com/a.png#top and http://example.com/plain.pdf.',
    'Slack <https://files.example.com/report.pdf|the report> then https://b.example.com/1',
    'https://b.example.com/2 https://b.example.com/3 https://b.example.com/4',
  ].join('\n');
  assert.deepEqual(messageLinks(text), {
    read: [
      'https://example.com/a.png',
      'https://en.wikipedia.org/wiki/Tulip_(flower)',
      'https://files.example.com/report.pdf',
      'https://b.example.com/1',
      'https://b.example.com/2',
    ],
    extra: ['https://b.example.com/3', 'https://b.example.com/4'],
  });
  assert.deepEqual(messageLinks('no links here'), { read: [], extra: [] });
});

test('reading links fetches at most three at once, reuses kept reads and never fails on a fetch error', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetched = [];
  const kept = [];
  const links = ['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4'];
  const outcome = await readMessageLinks({
    workspaceId: 'w',
    conversationId: 'c',
    messageId: 'm',
    links: [...links, 'https://a.example/kept'],
    kept: [{ url: 'https://a.example/kept', outcome: 'page' }],
    reader: {
      async fetch(url) {
        fetched.push(url);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 10));
        inFlight -= 1;
        if (url.endsWith('/4')) throw new Error('socket hang up');
        return { kind: 'failed', url, reason: 'sign-in-required' };
      },
      async keep(_workspace, input) {
        kept.push(input.ordinal);
        return { url: input.result.url, outcome: 'failed', reason: input.result.reason };
      },
    },
    signal: new AbortController().signal,
  });
  assert.equal(peak, 3);
  assert.deepEqual(fetched.sort(), links);
  assert.deepEqual(
    outcome.reads.map(read => [read.url, read.outcome, read.reason]),
    [
      ['https://a.example/1', 'failed', 'sign-in-required'],
      ['https://a.example/2', 'failed', 'sign-in-required'],
      ['https://a.example/3', 'failed', 'sign-in-required'],
      ['https://a.example/4', 'failed', 'unavailable'],
      ['https://a.example/kept', 'page', undefined],
    ],
  );
  assert.equal(outcome.webOff, false);
});

test('the links notice names files, pages, failures, extra links and web access off', () => {
  const notice = linkNotice(
    [
      {
        url: 'https://a.example/x.png',
        outcome: 'file',
        attachmentId: 'id',
        filename: 'x.png',
        mediaType: 'image/png',
        size: 3,
      },
      { url: 'https://a.example/page', outcome: 'page' },
      { url: 'https://a.example/private', outcome: 'failed', reason: 'sign-in-required' },
      { url: 'https://a.example/huge', outcome: 'failed', reason: 'too-large' },
    ],
    ['https://a.example/sixth'],
    false,
  );
  assert.match(notice, /^<chat-links>/);
  assert.match(notice, /x\.png[^\n]*read as the file "x\.png"/);
  assert.match(notice, /page[^\n]*a web page, not read; call web\.fetch/);
  assert.match(notice, /private[^\n]*sign/i);
  assert.match(notice, /huge[^\n]*larger than 10 MB/);
  assert.match(notice, /sixth[^\n]*only the first 5 links/);
  const off = linkNotice([], ['https://a.example/x.png'], true);
  assert.match(off, /web access is off/);
  assert.equal(linkNotice([], [], false), '');
});
