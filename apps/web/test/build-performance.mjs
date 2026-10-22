import { build } from 'vite';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

await build({
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [
    {
      name: 'measure-bundles',
      generateBundle(_options, bundle) {
        const chunks = Object.values(bundle).filter(output => output.type === 'chunk');
        const report = chunks.map(chunk => ({
          file: chunk.fileName,
          entry: chunk.isEntry,
          bytes: Buffer.byteLength(chunk.code),
          gzipBytes: gzipSync(chunk.code).length,
          imports: chunk.imports,
          modules: Object.entries(chunk.modules)
            .map(([id, module]) => ({ id: id.replace(process.cwd(), '.'), bytes: module.renderedLength }))
            .sort((a, b) => b.bytes - a.bytes),
        }));
        this.emitFile({ type: 'asset', fileName: 'bundle-analysis.json', source: JSON.stringify(report, null, 2) });
        console.log(
          'Largest entry modules',
          report.filter(chunk => chunk.entry).flatMap(chunk => chunk.modules.slice(0, 20)),
        );
      },
    },
  ],
});
