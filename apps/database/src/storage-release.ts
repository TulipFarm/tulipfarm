import { parseArgs } from 'node:util';
import { z } from 'zod';

export class StorageReleaseError extends Error {}
const days = z.number().int().min(7).max(35);
const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('keys'), apply: z.boolean() }),
  z.object({ kind: z.literal('logins'), apply: z.boolean() }),
  z.object({ kind: z.literal('retention'), apply: z.boolean(), days, expectedCurrent: days.optional() }),
  z.object({ kind: z.literal('restore-retention'), apply: z.boolean(), days, expectedCurrent: days.optional() }),
]);
export type StorageReleaseCommand = z.infer<typeof commandSchema>;
export type StorageReleasePhase = 'keys' | 'logins' | 'activation';
export const storageReleaseHelp = `Storage release configuration (production only)
  node apps/database/dist/storage-release-cli.js <command> --env production [options]

Commands (read-only plan by default):
  keys                 Create missing independent runtime/migration/confirmation keys and IDs.
  logins               Configure scoped provisioner and three capability registry logins.
  retention            Plan Azure backup retention, default --days 30.
  restore-retention    Restore a prior retention setting; requires --days <prior-days>.

Options:
  --apply              Explicitly execute configuration writes after prerequisite checks.
  --days <7..35>       Managed PostgreSQL backup retention only.
  --expected-current <7..35>
                       Required for retention apply/restore; compare before updating.
  --help               Print this help without accessing Azure or PostgreSQL.

Login commands reject missing/drifted global migrations and missing isolated-v1.
Keys allow recognized legacy inventory before reset, or a fully installed isolated registry.
Retention does not access PostgreSQL or workspace secrets. No migrations run.
Ready isolated workspaces are checked against generated roles, owned schemas,
admission/readiness evidence and the packaged common stream (maximum 1000).
Login preparation accepts a nonempty exact historical prefix before common rollout.
Final activation requires the complete current stream. Login preparation runs no migrations.
Legacy memberships block login activation. Run the separately reviewed targeted reset.
Production sources: src/config.ts, database-admin-url from the database secret store (src/secrets.ts).
Run one release operator at a time; keep cutover writers stopped. Keys are create-only,
not rotation. Retention restore changes the setting, not already-expired backups.
Output includes secret references and key IDs, never secret values or connection URLs.
`;

export function parseStorageReleaseArgs(args: string[]): StorageReleaseCommand | 'help' {
  if (args.length === 1 && args[0] === '--help') return 'help';
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        env: { type: 'string' },
        apply: { type: 'boolean', default: false },
        days: { type: 'string' },
        'expected-current': { type: 'string' },
      },
    });
    const flags = args.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]);
    if (new Set(flags).size !== flags.length || values.env !== 'production' || positionals.length !== 1)
      throw new Error();
    const kind = positionals[0];
    if (kind === 'keys' || kind === 'logins') {
      if (values.days !== undefined || values['expected-current'] !== undefined) throw new Error();
      return commandSchema.parse({ kind, apply: values.apply });
    }
    if (kind === 'restore-retention' && values.days === undefined) throw new Error();
    if (values.apply && values['expected-current'] === undefined) throw new Error();
    for (const value of [values.days, values['expected-current']])
      if (value !== undefined && !/^\d+$/.test(value)) throw new Error();
    return commandSchema.parse({
      kind,
      apply: values.apply,
      days: Number(values.days ?? 30),
      expectedCurrent: values['expected-current'] === undefined ? undefined : Number(values['expected-current']),
    });
  } catch {
    throw new StorageReleaseError('Invalid storage release arguments. Use --help.');
  }
}

export const releaseCapabilities = ['runtime', 'migration', 'confirmation'] as const;
export const releaseRoleSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/)
  .refine(role => !/^(pg_|ws_)/.test(role));
export const releaseLoginSchema = z.object({
  capability: z.enum(['provisioning', 'authoring', 'confirmation', 'migration']),
  role: releaseRoleSchema,
  secret: z.string().regex(/^[a-z][a-z0-9-]{0,126}$/),
});
export type ReleaseLogin = z.infer<typeof releaseLoginSchema>;
export const releaseLoginListSchema = z
  .tuple([
    releaseLoginSchema.extend({ capability: z.literal('provisioning') }),
    releaseLoginSchema.extend({ capability: z.literal('authoring') }),
    releaseLoginSchema.extend({ capability: z.literal('confirmation') }),
    releaseLoginSchema.extend({ capability: z.literal('migration') }),
  ])
  .refine(
    logins =>
      new Set(logins.map(login => login.role)).size === 4 && new Set(logins.map(login => login.secret)).size === 4,
  );
export const releaseLogins = [
  { capability: 'provisioning', role: 'tulipfarm_storage_provisioner', secret: 'workspace-provisioning-database-url' },
  { capability: 'authoring', role: 'tulipfarm_storage_authoring', secret: 'workspace-authoring-database-url' },
  {
    capability: 'confirmation',
    role: 'tulipfarm_storage_confirmation',
    secret: 'workspace-confirmation-registry-database-url',
  },
  { capability: 'migration', role: 'tulipfarm_storage_migration', secret: 'workspace-migration-registry-database-url' },
] as const;

export type StorageReleaseDependencies = {
  prerequisites(phase: StorageReleasePhase): Promise<{ credentialsExist: boolean }>;
  readSecret(name: string): Promise<string | undefined>;
  saveSecret(name: string, value: string): Promise<void>;
  randomHex(): string;
  loginUrl(login: ReleaseLogin, password: string): string;
  loginPassword(login: ReleaseLogin, url: string): string;
  inspectLogins(): Promise<void>;
  configureLogin(login: ReleaseLogin, password: string): Promise<void>;
  verifyLogin(login: ReleaseLogin, url: string): Promise<void>;
  retention(): Promise<number>;
  setRetention(days: number): Promise<void>;
};

export async function runStorageRelease(input: StorageReleaseCommand, dependencies: StorageReleaseDependencies) {
  const command = commandSchema.parse(input);
  if (
    (command.kind === 'retention' || command.kind === 'restore-retention') &&
    command.apply &&
    command.expectedCurrent === undefined
  ) {
    throw new StorageReleaseError('Retention writes require --expected-current.');
  }
  if (command.kind === 'retention' || command.kind === 'restore-retention') {
    const current = days.parse(await dependencies.retention());
    if (command.expectedCurrent !== undefined && command.expectedCurrent !== current) {
      throw new StorageReleaseError('Backup retention differs from --expected-current. Replan before applying.');
    }
    if (command.apply && current !== command.days) {
      if ((await dependencies.retention()) !== current)
        throw new StorageReleaseError('Backup retention changed after planning. Replan before applying.');
      await dependencies.setRetention(command.days);
      if ((await dependencies.retention()) !== command.days)
        throw new StorageReleaseError('Backup retention update was not verified. Inspect and replan.');
    }
    return {
      command: command.kind,
      mode: command.apply ? 'apply' : 'plan',
      previousDays: current,
      desiredDays: command.days,
      changed: command.apply && current !== command.days,
      restoreCommand: `node apps/database/dist/storage-release-cli.js restore-retention --env production --days ${current} --expected-current ${command.days} --apply`,
    };
  }
  const prerequisites = await dependencies.prerequisites(command.kind);
  if (command.kind === 'keys') {
    const keys = await Promise.all(
      releaseCapabilities.map(async capability => {
        const secret = `workspace-${capability}-key`;
        const value = await dependencies.readSecret(secret);
        const id = await dependencies.readSecret(`${secret}-id`);
        if (
          (value !== undefined && !/^[a-f0-9]{64}$/i.test(value)) ||
          (id !== undefined && !/^[a-zA-Z0-9._-]{1,128}$/.test(id))
        ) {
          throw new StorageReleaseError('Invalid stored capability key or key ID. Reconcile without overwriting.');
        }
        if (prerequisites.credentialsExist && (value === undefined || id === undefined)) {
          throw new StorageReleaseError(
            'Encrypted workspace credentials exist. Recover missing keys and IDs; do not generate replacements.',
          );
        }
        return { secret, value, id: id ?? `${capability}-v1`, missingId: id === undefined };
      }),
    );
    const existing = keys.flatMap(key => (key.value === undefined ? [] : [key.value.toLowerCase()]));
    if (new Set(existing).size !== existing.length)
      throw new StorageReleaseError('Workspace capability keys must be independent.');
    const material = new Set(existing);
    const generated = new Map<string, string>();
    if (command.apply)
      for (const key of keys) {
        if (key.value !== undefined) continue;
        const value = dependencies.randomHex();
        if (!/^[a-f0-9]{64}$/.test(value) || material.has(value))
          throw new StorageReleaseError('Independent key generation failed.');
        material.add(value);
        generated.set(key.secret, value);
      }
    for (const key of keys) {
      if (!command.apply) continue;
      if (key.missingId) await dependencies.saveSecret(`${key.secret}-id`, key.id);
      const value = generated.get(key.secret);
      if (value !== undefined) await dependencies.saveSecret(key.secret, value);
    }
    return {
      command: command.kind,
      mode: command.apply ? 'apply' : 'plan',
      keys: keys.map(key => ({
        secret: `production-${key.secret}`,
        keyIdSecret: `production-${key.secret}-id`,
        keyId: key.id,
        action: key.value === undefined || key.missingId ? 'create-missing' : 'retain',
      })),
    };
  }
  await dependencies.inspectLogins();
  const logins = await Promise.all(
    releaseLogins.map(async login => {
      const url = await dependencies.readSecret(login.secret);
      return { login, url, password: url === undefined ? undefined : dependencies.loginPassword(login, url) };
    }),
  );
  for (const { login, url, password } of logins) {
    if (!command.apply) continue;
    const stablePassword = password ?? dependencies.randomHex();
    const stableUrl = url ?? dependencies.loginUrl(login, stablePassword);
    if (url === undefined) await dependencies.saveSecret(login.secret, stableUrl);
    await dependencies.configureLogin(login, stablePassword);
    await dependencies.verifyLogin(login, stableUrl);
  }
  return {
    command: command.kind,
    mode: command.apply ? 'apply' : 'plan',
    logins: logins.map(({ login, url }) => ({
      role: login.role,
      secret: `production-${login.secret}`,
      action: url === undefined ? 'create' : 'reconcile',
    })),
  };
}
