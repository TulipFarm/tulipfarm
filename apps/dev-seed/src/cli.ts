import { createSeedContext } from './context.ts';
import { SeedRefused, apiOrigin, loadLocalEnv, webOrigin } from './env.ts';
import { manifestPath, readManifest, writeManifest, type Manifest } from './manifest.ts';
import { createRandom } from './random.ts';
import { generators, people, runGenerator, scenarios } from './registry.ts';
import { booleanFlags, parseFlags } from './options.ts';
import { resetSeed } from './reset.ts';
import { ensureUser, ensureWorkspace, signInUrl } from './workspace.ts';

const usage = `Usage:
  pnpm seed --list                                   List scenarios and generators
  pnpm seed <scenario> [--seed N] [--workspace slug] Run a scenario (idempotent)
  pnpm seed add <generator> --workspace slug [--option value ...]
  pnpm seed manifest [--json]                        Show what has been seeded
  pnpm seed:reset (--workspace slug ... | --all) [--users]

Read docs/mock-data.md for details.`;

function printList() {
  console.log('Scenarios:');
  for (const scenario of scenarios) console.log(`  ${scenario.name.padEnd(12)} ${scenario.description}`);
  console.log('\nGenerators (pnpm seed add <name> --workspace <slug>):');
  for (const generator of generators) {
    console.log(`  ${generator.name.padEnd(12)} ${generator.description}`);
    console.log(`  ${''.padEnd(12)} requires: ${generator.requires.join(', ')}`);
    for (const [option, description] of Object.entries(generator.options))
      console.log(`  ${''.padEnd(14)}--${option}: ${description}`);
  }
}

function printSummary(manifest: Manifest, slugs: string[]) {
  for (const slug of slugs) {
    const workspace = manifest.workspaces[slug];
    if (!workspace) continue;
    console.log(`\n${workspace.name} (${slug}) — ${workspace.url}`);
    console.log(`  Sign in as owner: ${signInUrl(workspace.owner, `/${slug}`)}`);
    for (const member of workspace.members.filter(item => item.email !== workspace.owner))
      console.log(`  Sign in as ${member.email} (${member.role}): ${signInUrl(member.email, `/${slug}`)}`);
    const counts = Object.entries(workspace.entities).map(([kind, items]) => `${kind} ${items.length}`);
    if (counts.length) console.log(`  Entities: ${counts.join(', ')}`);
    for (const [generator, reason] of Object.entries(workspace.unavailable))
      console.log(`  Unavailable ${generator}: ${reason}`);
  }
  console.log(`\nManifest: ${manifestPath}`);
}

async function main() {
  const { values, positionals, workspaces } = parseFlags(process.argv.slice(2));
  const [command, name] = positionals;
  if (values.help || (!command && !values.list)) {
    console.log(usage);
    return;
  }
  if (values.list || command === 'list') {
    printList();
    return;
  }
  if (command === 'manifest') {
    const manifest = await readManifest(webOrigin(), apiOrigin());
    if (values.json) console.log(JSON.stringify(manifest, null, 2));
    else printSummary(manifest, Object.keys(manifest.workspaces));
    return;
  }
  loadLocalEnv();
  const manifest = await readManifest(webOrigin(), apiOrigin());
  const slugs = workspaces;
  const log = (message: string) => console.log(message);
  if (command === 'reset') {
    if (!values.all && !slugs.length) throw new Error('Pass --workspace <slug> or --all.');
    const removed = await resetSeed(manifest, { slugs: values.all ? 'all' : slugs, users: Boolean(values.users) }, log);
    await writeManifest(manifest);
    console.log(`Reset ${removed} workspace(s).`);
    return;
  }
  const seed = typeof values.seed === 'string' ? Number(values.seed) : 1;
  if (!Number.isInteger(seed)) throw new Error('--seed must be an integer');
  const context = createSeedContext(manifest, createRandom(seed), log);
  const before = new Set(Object.keys(manifest.workspaces));
  try {
    if (command === 'add') {
      if (!name)
        throw new Error('Name a generator: pnpm seed add <generator> --workspace <slug>. Run pnpm seed --list.');
      const slug = slugs[0];
      if (!slug) throw new Error('Pass --workspace <slug>.');
      const owner = await ensureUser(context, people.owner.email, people.owner.name);
      const known = manifest.workspaces[slug];
      const workspace = known ?? (await ensureWorkspace(context, owner, { slug, name: slug, scenario: 'custom' }));
      const options = Object.fromEntries(
        Object.entries(values).filter(([key]) => !['seed', ...booleanFlags].includes(key)),
      );
      await runGenerator(
        context,
        { workspace, owner: context.manifest.users[workspace.owner] ?? owner },
        name,
        options,
      );
      await writeManifest(manifest);
      printSummary(manifest, [workspace.slug]);
      return;
    }
    const scenario = scenarios.find(item => item.name === command);
    if (!scenario) throw new Error(`Unknown scenario ${command}. Run pnpm seed --list.`);
    const options = { ...values, workspace: slugs[0] };
    try {
      await scenario.run(context, options);
    } finally {
      await writeManifest(manifest);
    }
    const touched = Object.values(manifest.workspaces)
      .filter(item => item.scenario === scenario.name || !before.has(item.slug))
      .map(item => item.slug);
    printSummary(manifest, touched);
  } finally {
    await context.close();
  }
}

main().catch(error => {
  if (error instanceof SeedRefused) console.error(error.message);
  else console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
