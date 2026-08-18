/**
 * Command-line parsing for `pnpm eval`, kept apart from `cli.ts` so it can be tested.
 *
 * Everything here exists to make a mistyped ceiling loud. A Sweep that silently ran unbounded
 * because an option was spelled `--max-token` is worse than one that refused to start: the
 * operator believes the run was bounded, and no output can tell them otherwise.
 */

export const FLAGS = [
  "--corpus",
  "--case",
  "--model",
  "--max-spend",
  "--max-tokens",
  "--max-tokens-per-trial",
  "--baseline",
  "--promote",
  "--repeat",
  "--save",
  "--save-dir",
] as const;

/**
 * Accepts both `--name value` and `--name=value`; the second form used to be dropped silently.
 *
 * A following `--option` is never taken as the value. `--max-tokens --model terra` would otherwise
 * read as a ceiling of "--model", which fails a number check loudly only by luck.
 */
export function flag(argv: string[], name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const next = argv[at + 1];
  return next === undefined || next.startsWith("--") ? undefined : next;
}

/** Whether a valueless option such as `--promote` was given at all. */
export function present(argv: string[], name: string): boolean {
  return argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

/** Rejects any `--option` not in {@link FLAGS}, so a typo cannot pass for an absent ceiling. */
export function assertKnownFlags(argv: string[]): void {
  for (const arg of argv) {
    if (!arg.startsWith("--") || arg === "--help") continue;
    const name = arg.split("=")[0] ?? arg;
    if (!FLAGS.includes(name as (typeof FLAGS)[number])) {
      throw new Error(`unknown option "${name}" — supported: ${FLAGS.join(", ")}`);
    }
  }
}

export function positive(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}
