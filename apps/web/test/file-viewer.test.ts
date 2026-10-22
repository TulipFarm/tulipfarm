import assert from 'node:assert/strict';
import test from 'node:test';
import { fileKind, googleDocument, googleShortcut, renderableType } from '../src/lib/file-viewer.ts';

test('local formats resolve from filenames when the file picker supplies no MIME type', () => {
  for (const [name, expected] of [
    ['REPORT.XLSX', 'sheet'],
    ['older.xls', 'sheet'],
    ['deck.pptx', 'slides'],
    ['document.docx', 'document'],
    ['report.pdf', 'pdf'],
    ['notes.md', 'markdown'],
    ['data.json', 'json'],
    ['notes.txt', 'text'],
    ['image.avif', 'image'],
    ['document.gdoc', 'google'],
  ]) {
    assert.equal(fileKind(name ?? '', ''), expected);
  }
  assert.equal(fileKind('old-deck.ppt', 'application/vnd.ms-powerpoint'), 'unsupported');
});

test('Google embed links accept only Google document hosts and supported document paths', () => {
  const document = googleDocument('https://docs.google.com/document/d/abc-123/edit?usp=sharing');
  assert.equal(document?.url, 'https://docs.google.com/document/d/abc-123/edit');
  assert.equal(
    googleDocument('https://docs.google.com/spreadsheets/d/sheet-123/edit')?.mediaType,
    'application/vnd.google-apps.spreadsheet',
  );
  assert.equal(
    googleDocument('https://docs.google.com/presentation/d/deck-123/edit')?.embedUrl,
    'https://docs.google.com/presentation/d/deck-123/embed',
  );
  for (const url of [
    'https://docs.google.com.evil.test/document/d/abc/edit',
    'http://docs.google.com/document/d/abc/edit',
    'https://name@docs.google.com/document/d/abc/edit',
    'javascript:alert(1)',
    'https://docs.google.com/forms/d/abc/edit',
  ])
    assert.equal(googleDocument(url), null);
});

test('Google desktop shortcuts resolve a document link and reject malformed content', () => {
  assert.equal(
    googleShortcut('{"url":"https://docs.google.com/document/d/abc/edit"}'),
    'https://docs.google.com/document/d/abc/edit',
  );
  assert.throws(() => googleShortcut('{"url":"https://example.com"}'));
  assert.throws(() => googleShortcut('{"url":42}'));
  assert.throws(() => googleShortcut('not json'));
});

test('viewer blobs never carry a script-capable image type in any letter case', () => {
  for (const type of [
    'image/svg+xml',
    'image/SVG+XML',
    'image/Svg+Xml',
    ' image/svg+xml ',
    'image/svg',
    'image/x-unknown',
    'text/html',
  ]) {
    assert.equal(renderableType('drawing.png', type), 'application/octet-stream', type);
    assert.equal(renderableType('drawing.svg', type), 'application/octet-stream', type);
  }
  assert.equal(renderableType('photo.png', 'image/png'), 'image/png');
  assert.equal(renderableType('photo.JPG', 'Image/JPEG'), 'image/jpeg');
  assert.equal(renderableType('photo.webp', ''), 'application/octet-stream');
  assert.equal(renderableType('report.pdf', 'application/pdf'), 'application/pdf');
});
