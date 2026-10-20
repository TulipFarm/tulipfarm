import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const source = process.env.TASK_ACCOUNTING_AUDIT_ROOT;
if (!source) throw new Error('TASK_ACCOUNTING_AUDIT_ROOT is required');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@tulipfarm/') && context.parentURL?.startsWith(pathToFileURL(`${source}/`).href)) {
      const localParent = resolve(process.cwd(), fileURLToPath(context.parentURL).slice(source.length + 1));
      return nextResolve(specifier, { ...context, parentURL: pathToFileURL(localParent).href });
    }
    if (
      specifier.startsWith('.') &&
      !context.parentURL?.includes('/node_modules/') &&
      context.parentURL?.startsWith(pathToFileURL(`${source}/`).href)
    ) {
      const original = fileURLToPath(new URL(specifier, context.parentURL));
      const local = resolve(process.cwd(), original.slice(source.length + 1));
      if (existsSync(local)) return nextResolve(pathToFileURL(local).href, context);
    }
    return nextResolve(specifier, context);
  },
});
