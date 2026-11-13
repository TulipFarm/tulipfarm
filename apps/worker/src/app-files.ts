import { createHash } from 'node:crypto';
import { appLimits, type AppFailure } from '@tulipfarm/apps';
import type { AppFile } from '@tulipfarm/extensions';

/** A built file, held in memory until it is stored. */
export type AppBuiltFile = { readonly path: string; readonly content: Buffer };

const contentTypes: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  webmanifest: 'application/manifest+json',
};

export function contentTypeOf(path: string) {
  const dot = path.lastIndexOf('.');
  return (dot > path.lastIndexOf('/') && contentTypes[path.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

const failure = (code: AppFailure['code'], message: string): AppFailure => ({ code, message, retryable: false });

/** A relative path with no empty, `.` or `..` segment, so a file can never be stored outside its release. */
function relativePath(path: string) {
  const trimmed = path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!trimmed || trimmed.startsWith('/') || /[\\\0]/.test(trimmed)) return null;
  const segments = trimmed.split('/');
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..') ? trimmed : null;
}

/** Checks paths and artifact limits, then describes the files as a manifest sorted by path. */
export function appManifest(files: readonly AppBuiltFile[]):
  | {
      readonly ok: true;
      readonly files: readonly AppFile[];
      readonly contents: ReadonlyMap<string, Buffer>;
      readonly bytes: number;
    }
  | { readonly ok: false; readonly failure: AppFailure } {
  if (files.length > appLimits.artifactFiles)
    return {
      ok: false,
      failure: failure('limit-exceeded', `The build made more than ${appLimits.artifactFiles} files`),
    };
  const contents = new Map<string, Buffer>();
  const manifest: AppFile[] = [];
  let bytes = 0;
  for (const file of files) {
    const path = relativePath(file.path);
    if (!path)
      return { ok: false, failure: failure('build-failed', `The build made a file outside its folder: ${file.path}`) };
    if (contents.has(path)) return { ok: false, failure: failure('build-failed', `The build made ${path} twice`) };
    contents.set(path, file.content);
    bytes += file.content.length;
    if (bytes > appLimits.artifactBytes)
      return { ok: false, failure: failure('limit-exceeded', 'The build output is larger than 50 MB') };
    manifest.push({
      path,
      sha256: createHash('sha256').update(file.content).digest('hex'),
      bytes: file.content.length,
      contentType: contentTypeOf(path),
    });
  }
  manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, files: manifest, contents, bytes };
}

const block = 512;

function field(header: Buffer, start: number, length: number) {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function octal(header: Buffer, start: number, length: number) {
  const text = field(header, start, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function paxPath(content: Buffer) {
  let path: string | undefined;
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(content.subarray(offset, space).toString('utf8'));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = content.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (record.slice(0, equals) === 'path') path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

/**
 * Reads the regular files of a tar archive. Links of any kind and device files fail the build, since a link could
 * point outside the output folder.
 */
export function untar(
  archive: Buffer,
):
  | { readonly ok: true; readonly files: readonly AppBuiltFile[] }
  | { readonly ok: false; readonly failure: AppFailure } {
  const files: AppBuiltFile[] = [];
  let offset = 0;
  let nextPath: string | undefined;
  while (offset + block <= archive.length) {
    const header = archive.subarray(offset, offset + block);
    if (header.every(byte => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    const path = nextPath ?? (prefix ? `${prefix}/${name}` : name);
    const start = offset + block;
    const content = archive.subarray(start, start + size);
    if (content.length !== size)
      return { ok: false, failure: failure('build-failed', 'The build output is truncated') };
    offset = start + Math.ceil(size / block) * block;
    if (type === 'x') {
      nextPath = paxPath(content);
      continue;
    }
    nextPath = undefined;
    if (type === 'g' || type === '5') continue;
    if (type !== '0' && type !== '\0')
      return { ok: false, failure: failure('build-failed', `The build output has a link or special file: ${path}`) };
    files.push({ path, content: Buffer.from(content) });
  }
  return { ok: true, files };
}
