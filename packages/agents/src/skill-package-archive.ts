import { fromBuffer, type Entry } from 'yauzl';
import type { Readable } from 'node:stream';
import { SkillPackageError, skillPackageLimits, skillPathSchema } from './skill-package-contracts.ts';
import type { SkillPackageFile } from './skill-packages.ts';

export function readSkillArchive(bytes: Uint8Array, signal: AbortSignal): Promise<SkillPackageFile[]> {
  if (bytes.byteLength > skillPackageLimits.sourceBytes) return Promise.reject(new SkillPackageError('source-limit'));
  return new Promise((resolve, reject) => {
    fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new SkillPackageError('invalid-package'));
          return;
        }
        const files: SkillPackageFile[] = [];
        const names = new Set<string>();
        let total = 0,
          count = 0,
          settled = false;
        let active: Readable | undefined;
        const fail = (code: 'invalid-package' | 'source-limit' | 'source-unavailable') => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          active?.destroy();
          zip.close();
          reject(new SkillPackageError(code));
        };
        const abort = () => fail('source-unavailable');
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        zip.on('error', () => fail('invalid-package'));
        zip.on('end', () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          resolve(files);
        });
        zip.on('entry', (entry: Entry) => {
          if (settled) return;
          const directory = entry.fileName.endsWith('/');
          const path = directory ? entry.fileName.slice(0, -1) : entry.fileName;
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          const parsed = skillPathSchema.safeParse(path);
          if (
            !parsed.success ||
            names.has(path.toLowerCase()) ||
            entry.isEncrypted() ||
            ![0, directory ? 0x4000 : 0x8000].includes(mode)
          ) {
            fail('invalid-package');
            return;
          }
          names.add(path.toLowerCase());
          total += entry.uncompressedSize;
          if (++count > skillPackageLimits.sourceFiles || total > skillPackageLimits.sourceBytes) {
            fail('source-limit');
            return;
          }
          if (directory) {
            if (entry.uncompressedSize) {
              fail('invalid-package');
              return;
            }
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail('invalid-package');
              return;
            }
            if (settled) {
              stream.destroy();
              return;
            }
            active = stream;
            const parts: Buffer[] = [];
            let length = 0;
            stream.on('data', (part: Buffer) => {
              length += part.length;
              if (length > entry.uncompressedSize || length > skillPackageLimits.bytes) {
                stream.destroy();
                fail('source-limit');
                return;
              }
              parts.push(part);
            });
            stream.on('error', () => fail('invalid-package'));
            stream.on('end', () => {
              if (settled) return;
              if (length !== entry.uncompressedSize) {
                fail('invalid-package');
                return;
              }
              files.push({ path, bytes: Buffer.concat(parts, length) });
              active = undefined;
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}
