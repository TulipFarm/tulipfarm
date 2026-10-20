import type { SeedContext } from './context.ts';
import type { ManifestUser, ManifestWorkspace } from './manifest.ts';

export type Options = Record<string, string | boolean | undefined>;
export type Target = { workspace: ManifestWorkspace; owner: ManifestUser };
export type Generator = {
  name: string;
  description: string;
  requires: string[];
  options: Record<string, string>;
  run: (context: SeedContext, target: Target, options: Options) => Promise<void>;
};

export function number(value: string | boolean | undefined, fallback: number) {
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Expected a non-negative integer, received ${value}`);
  return parsed;
}

export function text(value: string | boolean | undefined, fallback: string) {
  return typeof value === 'string' && value ? value : fallback;
}

export function primaryTeam(target: Target) {
  const team = target.workspace.teams[0];
  if (!team)
    throw new Error(
      `${target.workspace.slug} has no seeded team; run \`pnpm seed add team --workspace ${target.workspace.slug}\` first.`,
    );
  return team.id;
}

export function unavailable(context: SeedContext, target: Target, generator: string, reason: string) {
  target.workspace.unavailable[generator] = reason;
  context.log(`  ! ${generator} skipped: ${reason}`);
}

export const booleanFlags = new Set(['list', 'help', 'all', 'users', 'json']);

// Generator options are open-ended (`--count 500`), so flags are parsed by hand rather than with a fixed schema.
export function parseFlags(argv: string[]) {
  const values: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const workspaces: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '-h') {
      values.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const next = argv[index + 1];
    const value =
      inline ?? (booleanFlags.has(key) || next === undefined || next.startsWith('--') ? true : (index++, next));
    if (key === 'workspace') {
      if (typeof value === 'string') workspaces.push(value);
      else throw new Error('--workspace needs a slug');
    } else values[key] = value;
  }
  return { values, positionals, workspaces };
}
