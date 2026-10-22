import { parseArgs } from 'node:util';
import { z } from 'zod';

export class ProductReleaseError extends Error {}
export const productEmailRole = 'tulipfarm_email_delivery';
const hex = z.string().regex(/^[a-fA-F0-9]{64}$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const commandSchema = z.object({ kind: z.enum(['keys', 'email-login']), apply: z.boolean() });
export type ProductReleaseCommand = z.infer<typeof commandSchema>;
export const productReleaseHelp = `Product release preparation
  node apps/database/dist/product-release-cli.js <keys|email-login> --env production [--apply]
Read-only plan by default. Keys and login credentials are create-only, never rotation.
No maintenance app, model key, deployment, reset, or migration is involved.
Stop credential writers and run one release operator at a time.
Output contains references and key IDs, never secret values.
`;

export function parseProductReleaseArgs(args: string[]): ProductReleaseCommand | 'help' {
  if (args.length === 1 && args[0] === '--help') return 'help';
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { env: { type: 'string' }, apply: { type: 'boolean', default: false } },
    });
    const flags = args.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]);
    if (new Set(flags).size !== flags.length || values.env !== 'production' || positionals.length !== 1)
      throw new Error();
    return commandSchema.parse({ kind: positionals[0], apply: values.apply });
  } catch {
    throw new ProductReleaseError('Invalid product release arguments. Use --help.');
  }
}

export type ProductReleasePorts = {
  readSecret(name: string): Promise<string | undefined>;
  createSecret(name: string, value: string): Promise<void>;
  randomHex(): string;
  encryptedKeyIds(): Promise<{ email: string[]; integration: string[] }>;
  inspectEmailLogin(): Promise<'absent' | 'retained'>;
  createEmailLogin(password: string): Promise<void>;
  loginUrl(password: string): string;
  loginPassword(url: string): string;
  verifyEmailLogin(url: string): Promise<void>;
};

export async function runProductRelease(input: ProductReleaseCommand, ports: ProductReleasePorts) {
  const command = commandSchema.parse(input);
  if (command.kind === 'email-login') {
    const state = await ports.inspectEmailLogin();
    const stored = await ports.readSecret('email-delivery-database-url');
    if (state === 'retained' && stored === undefined)
      throw new ProductReleaseError('Existing email login has no stored credential. Recover it without rotation.');
    const password = stored === undefined ? undefined : ports.loginPassword(stored);
    if (stored !== undefined && state === 'retained') await ports.verifyEmailLogin(stored);
    if (command.apply && state === 'absent') {
      const stablePassword = password ?? hex.parse(ports.randomHex());
      const url = stored ?? ports.loginUrl(stablePassword);
      if (stored === undefined) await ports.createSecret('email-delivery-database-url', url);
      await ports.createEmailLogin(stablePassword);
      await ports.verifyEmailLogin(url);
    }
    return {
      command: command.kind,
      mode: command.apply ? 'apply' : 'plan',
      role: productEmailRole,
      secret: 'production-email-delivery-database-url',
      action: state === 'absent' ? 'create' : 'retain',
    };
  }
  const inventory = await ports.encryptedKeyIds();
  const bundles = [];
  for (const [kind, prefix, defaultId] of [
    ['email', 'email-delivery', 'email-v1'],
    ['integration', 'integration-credential', 'connection-v1'],
  ] as const) {
    const key = await ports.readSecret(`${prefix}-key`);
    const keyId = await ports.readSecret(`${prefix}-key-id`);
    const previousText = await ports.readSecret(`${prefix}-previous-keys`);
    let previous: Record<string, string>;
    try {
      if (key !== undefined) hex.parse(key);
      if (keyId !== undefined) id.parse(keyId);
      previous = z.record(id, hex).parse(JSON.parse(previousText ?? '{}'));
    } catch {
      throw new ProductReleaseError('Invalid product key configuration. Recover it without overwriting.');
    }
    if (key !== undefined && keyId === undefined)
      throw new ProductReleaseError('Existing key has no shared ID. Recover its ID without guessing.');
    const activeId = keyId ?? defaultId;
    if (Object.hasOwn(previous, activeId)) throw new ProductReleaseError('Active and previous key IDs overlap.');
    if (inventory[kind].length && (key === undefined || keyId === undefined || previousText === undefined)) {
      throw new ProductReleaseError(
        'Encrypted product data exists. Recover missing key configuration; never generate replacements.',
      );
    }
    if (inventory[kind].some(used => used !== activeId && !Object.hasOwn(previous, used))) {
      throw new ProductReleaseError('Encrypted product data references an unavailable key ID.');
    }
    bundles.push({ prefix, key, keyId, activeId, previousText, previous });
  }
  const material = bundles
    .flatMap(bundle => [...Object.values(bundle.previous), ...(bundle.key === undefined ? [] : [bundle.key])])
    .map(value => value.toLowerCase());
  if (new Set(material).size !== material.length)
    throw new ProductReleaseError('Product encryption keys must be independent.');
  const writes: { name: string; value: string }[] = [];
  if (command.apply)
    for (const bundle of bundles) {
      if (bundle.keyId === undefined) writes.push({ name: `${bundle.prefix}-key-id`, value: bundle.activeId });
      if (bundle.previousText === undefined) writes.push({ name: `${bundle.prefix}-previous-keys`, value: '{}' });
      if (bundle.key === undefined) {
        const value = hex.parse(ports.randomHex()).toLowerCase();
        if (material.includes(value)) throw new ProductReleaseError('Independent key generation failed.');
        material.push(value);
        writes.push({ name: `${bundle.prefix}-key`, value });
      }
    }
  for (const write of writes) await ports.createSecret(write.name, write.value);
  return {
    command: command.kind,
    mode: command.apply ? 'apply' : 'plan',
    keys: bundles.map(bundle => ({
      secret: `production-${bundle.prefix}-key`,
      keyIdSecret: `production-${bundle.prefix}-key-id`,
      keyId: bundle.activeId,
      previousKeysSecret: `production-${bundle.prefix}-previous-keys`,
      action:
        bundle.key === undefined || bundle.keyId === undefined || bundle.previousText === undefined
          ? 'create-missing'
          : 'retain',
    })),
  };
}
