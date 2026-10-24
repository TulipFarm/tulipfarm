import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import sharp from 'sharp';
import { sniffMediaType } from '../src/index.ts';
import { bigEndianTiff, bmp24 } from './encoders.mjs';

const fixture = name => readFile(new URL(`fixtures/${name}`, import.meta.url));
const bytes = (...parts) =>
  Uint8Array.from(
    parts.flatMap(part => (typeof part === 'string' ? Array.from(part, char => char.charCodeAt(0)) : part)),
  );
const solid = sharp({ create: { width: 4, height: 3, channels: 3, background: '#336699' } });

function zipWith(names) {
  return bytes(
    ...names.flatMap(name => [
      'PK\x03\x04',
      [20, 0, 8, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [name.length, 0, 0, 0],
      name,
    ]),
    'PK\x05\x06',
    Array.from({ length: 18 }, () => 0),
  );
}

test('identifies raster images from their bytes', async () => {
  const cases = [
    [await solid.clone().png().toBuffer(), 'image/png'],
    [await solid.clone().jpeg().toBuffer(), 'image/jpeg'],
    [await solid.clone().webp().toBuffer(), 'image/webp'],
    [await solid.clone().gif().toBuffer(), 'image/gif'],
    [await solid.clone().tiff().toBuffer(), 'image/tiff'],
    [bigEndianTiff(2, 2, [51, 102, 153]), 'image/tiff'],
    [bmp24(2, 2, [51, 102, 153]), 'image/bmp'],
    [await fixture('tiny.heic'), 'image/heic'],
    [await solid.clone().avif().toBuffer(), 'image/avif'],
    [await fixture('animated.gif'), 'image/gif'],
  ];
  for (const [input, mediaType] of cases) {
    assert.deepEqual(sniffMediaType(input), { mediaType, family: 'image' });
  }
});

test('trusts the bytes rather than a declared type', async () => {
  const declaredJpeg = { declaredType: 'image/jpeg', bytes: await solid.clone().png().toBuffer() };
  assert.deepEqual(sniffMediaType(declaredJpeg.bytes), { mediaType: 'image/png', family: 'image' });
});

test('identifies HEIF brands', () => {
  const ftyp = brand => bytes([0, 0, 0, 24], 'ftyp', brand, [0, 0, 0, 0], 'mif1');
  assert.deepEqual(sniffMediaType(ftyp('heic')), { mediaType: 'image/heic', family: 'image' });
  assert.deepEqual(sniffMediaType(ftyp('heix')), { mediaType: 'image/heic', family: 'image' });
  assert.deepEqual(sniffMediaType(ftyp('hevc')), { mediaType: 'image/heic', family: 'image' });
  assert.deepEqual(sniffMediaType(ftyp('mif1')), { mediaType: 'image/heif', family: 'image' });
  assert.deepEqual(sniffMediaType(ftyp('msf1')), { mediaType: 'image/heif', family: 'image' });
  assert.deepEqual(sniffMediaType(ftyp('heim')), { mediaType: 'image/heif', family: 'image' });
  assert.deepEqual(sniffMediaType(ftyp('xxxx')), { mediaType: 'image/heif', family: 'image' });
});

test('identifies AVIF by its major brand before its HEIF compatible brand', () => {
  const ftyp = brand => bytes([0, 0, 0, 24], 'ftyp', brand, [0, 0, 0, 0], 'mif1');
  assert.deepEqual(sniffMediaType(ftyp('avif')), { mediaType: 'image/avif', family: 'image' });
  assert.deepEqual(sniffMediaType(ftyp('avis')), { mediaType: 'image/avif', family: 'image' });
});

test('identifies SVG text after a BOM, XML declaration, comments and doctype', async () => {
  const svg = text => sniffMediaType(new TextEncoder().encode(text));
  const expected = { mediaType: 'image/svg+xml', family: 'image' };
  assert.deepEqual(sniffMediaType(await fixture('hostile.svg')), expected);
  assert.deepEqual(svg('<svg xmlns="http://www.w3.org/2000/svg"/>'), expected);
  assert.deepEqual(
    svg(
      '\uFEFF<?xml version="1.0"?>\n<!-- a -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x" [ <!ENTITY a "b"> ]>\n<!-- b --><svg>',
    ),
    expected,
  );
  assert.equal(svg('<html><svg></svg></html>'), null);
  assert.equal(svg('<svgfoo/>'), null);
});

test('identifies documents and archives', () => {
  assert.deepEqual(sniffMediaType(bytes('%PDF-1.7\n')), { mediaType: 'application/pdf', family: 'pdf' });
  assert.deepEqual(sniffMediaType(zipWith(['notes.txt'])), { mediaType: 'application/zip', family: 'archive' });
  assert.deepEqual(
    sniffMediaType(
      bytes(
        'PK\x05\x06',
        Array.from({ length: 18 }, () => 0),
      ),
    ),
    {
      mediaType: 'application/zip',
      family: 'archive',
    },
  );
  assert.deepEqual(sniffMediaType(zipWith(['[Content_Types].xml', 'word/document.xml'])), {
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    family: 'office',
  });
  assert.deepEqual(sniffMediaType(zipWith(['[Content_Types].xml', 'xl/workbook.xml'])), {
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    family: 'office',
  });
  assert.deepEqual(sniffMediaType(zipWith(['[Content_Types].xml', 'ppt/presentation.xml'])), {
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    family: 'office',
  });
});

test('identifies audio', () => {
  const cases = [
    [bytes('ID3', [4, 0, 0, 0, 0, 0, 0]), 'audio/mpeg'],
    [bytes([0xff, 0xfb, 0x90, 0x00]), 'audio/mpeg'],
    [bytes('RIFF', [36, 0, 0, 0], 'WAVEfmt '), 'audio/wav'],
    [bytes('OggS', [0, 2]), 'audio/ogg'],
    [bytes('fLaC', [0, 0, 0, 34]), 'audio/flac'],
    [bytes([0, 0, 0, 20], 'ftypM4A ', [0, 0, 0, 0], 'isom'), 'audio/mp4'],
  ];
  for (const [input, mediaType] of cases) {
    assert.deepEqual(sniffMediaType(input), { mediaType, family: 'audio' });
  }
});

test('identifies video', () => {
  const cases = [
    [bytes([0, 0, 0, 20], 'ftypisom', [0, 0, 2, 0], 'mp41'), 'video/mp4'],
    [bytes([0, 0, 0, 20], 'ftypmp42', [0, 0, 0, 0], 'mp42'), 'video/mp4'],
    [bytes([0, 0, 0, 20], 'ftypavc1', [0, 0, 0, 0], 'avc1'), 'video/mp4'],
    [bytes([0, 0, 0, 20], 'ftypqt  ', [0, 0, 2, 0], 'qt  '), 'video/quicktime'],
    [bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], 'webm'), 'video/webm'],
    [bytes([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x82, 0x88], 'matroska'), 'video/x-matroska'],
    [bytes('RIFF', [0, 0, 0, 0], 'AVI LIST'), 'video/x-msvideo'],
  ];
  for (const [input, mediaType] of cases) {
    assert.deepEqual(sniffMediaType(input), { mediaType, family: 'video' });
  }
});

test('returns null for bytes it does not recognise', () => {
  assert.equal(sniffMediaType(new Uint8Array()), null);
  assert.equal(sniffMediaType(bytes('hello world')), null);
  assert.equal(sniffMediaType(bytes([0xff, 0xf1, 0x50, 0x80])), null);
  assert.equal(sniffMediaType(bytes('RIFF', [0, 0, 0, 0], 'CDXA')), null);
  assert.equal(sniffMediaType(bytes('BM', [0, 0, 0, 0])), null);
});
