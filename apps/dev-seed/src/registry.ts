import type { SeedContext } from './context.ts';
import type { ManifestUser } from './manifest.ts';
import { ensureChats, ensureProject } from './chats.ts';
import { addRows, ensureTable, tableTemplates } from './tables.ts';
import { ensureMember, ensureTeam, ensureUser, ensureWorkspace, seedEmailDomain } from './workspace.ts';
import { extraGenerators } from './extras.ts';
import { seedAgentBuilder } from './agent-builder.ts';
import { number, primaryTeam, text, type Generator, type Options, type Target } from './options.ts';

export type { Generator, Options, Target };
export type Scenario = {
  name: string;
  description: string;
  run: (context: SeedContext, options: Options) => Promise<void>;
};

export const people = {
  owner: { email: `dev@${seedEmailDomain}`, name: 'Dev User' },
  admin: { email: `alex.admin@${seedEmailDomain}`, name: 'Alex Admin' },
  manager: { email: `tom.manager@${seedEmailDomain}`, name: 'Tom Manager' },
  member: { email: `mia.member@${seedEmailDomain}`, name: 'Mia Member' },
  outsider: { email: `vic.viewer@${seedEmailDomain}`, name: 'Vic Viewer' },
} as const;

export const generators: Generator[] = [
  {
    name: 'member',
    description: 'Add a user to the workspace through a redeemed email invitation.',
    requires: ['workspace'],
    options: {
      email: 'member email (default mia.member@tulipfarm.test)',
      name: 'display name',
      role: 'admin | member (default member)',
    },
    async run(context, target, options) {
      const user = await ensureUser(
        context,
        text(options.email, people.member.email),
        text(options.name, people.member.name),
      );
      await ensureMember(context, target.workspace, target.owner, user, options.role === 'admin' ? 'admin' : 'member');
    },
  },
  {
    name: 'team',
    description: 'Create a team; the owner manages it and listed members are enrolled.',
    requires: ['workspace'],
    options: {
      name: 'team name (default Operations)',
      members: 'comma-separated member emails already in the workspace',
      managers: 'comma-separated manager emails',
    },
    async run(context, target, options) {
      const name = text(options.name, 'Operations');
      const list = (value: string | boolean | undefined) =>
        typeof value === 'string'
          ? value
              .split(',')
              .map(item => item.trim())
              .filter(Boolean)
          : [];
      await ensureTeam(context, target.workspace, target.owner, {
        key: name.toLowerCase(),
        name,
        members: list(options.members),
        managers: list(options.managers),
      });
    },
  },
  {
    name: 'table',
    description: `Create an active table from a template (${Object.keys(tableTemplates).join(', ')}) with rows.`,
    requires: ['workspace', 'team'],
    options: {
      template: 'template name (default contacts)',
      label: 'table label (default template label)',
      rows: 'initial rows (default 20)',
    },
    async run(context, target, options) {
      await ensureTable(context, target.workspace, target.owner, {
        template: text(options.template, 'contacts'),
        ...(typeof options.label === 'string' ? { label: options.label } : {}),
        teamId: primaryTeam(target),
        rows: number(options.rows, 20),
      });
    },
  },
  {
    name: 'rows',
    description: 'Append generated rows to a seeded table.',
    requires: ['table'],
    options: { table: 'table label (default Contacts)', count: 'rows to add (default 100)' },
    async run(context, target, options) {
      const label = text(options.table, 'Contacts');
      const table = target.workspace.entities.tables?.find(item => item.label.toLowerCase() === label.toLowerCase());
      const template = Object.entries(tableTemplates).find(
        ([, value]) => value.label.toLowerCase() === label.toLowerCase(),
      )?.[0];
      if (!table || !template) throw new Error(`No seeded table labelled ${label} in ${target.workspace.slug}`);
      await addRows(context, target.workspace, target.owner, {
        tableId: table.id,
        template,
        rows: number(options.count, 100),
      });
    },
  },
  {
    name: 'chats',
    description: 'Create chats with scripted assistant replies (no model calls).',
    requires: ['workspace'],
    options: {
      count: 'chats (default 3)',
      turns: 'user turns per chat (default 2)',
      as: 'member email to own the chats (default owner)',
      project: 'project name to file chats under',
    },
    async run(context, target, options) {
      const email = text(options.as, target.owner.email);
      const user = context.manifest.users[email];
      if (!user) throw new Error(`${email} is not a seeded user`);
      const project =
        typeof options.project === 'string'
          ? target.workspace.entities.projects?.find(item => item.label === options.project)?.id
          : undefined;
      await ensureChats(context, target.workspace, user, {
        count: number(options.count, 3),
        turns: number(options.turns, 2),
        key: `add-${context.random.int(0, 1e9)}`,
        ...(project ? { projectId: project } : {}),
      });
    },
  },
  {
    name: 'project',
    description: 'Create a project with instructions and a text knowledge entry.',
    requires: ['workspace'],
    options: { name: 'project name (default Spring launch)' },
    async run(context, target, options) {
      await ensureProject(context, target.workspace, target.owner, {
        name: text(options.name, 'Spring launch'),
        instructions: 'Keep answers short and cite the launch checklist.',
        knowledge: [
          { title: 'Launch checklist', content: '1. Confirm suppliers\n2. Update price list\n3. Brief the shop team' },
        ],
      });
    },
  },
  ...extraGenerators,
];

async function owner(context: SeedContext) {
  return ensureUser(context, people.owner.email, people.owner.name);
}

async function basic(
  context: SeedContext,
  options: Options,
  slug = 'seed-basic',
  scenario = 'basic',
  name = 'Seed Basic',
) {
  const user = await owner(context);
  const workspace = await ensureWorkspace(context, user, { slug: text(options.workspace, slug), name, scenario });
  const target = { workspace, owner: user };
  const mia = await ensureUser(context, people.member.email, people.member.name);
  await ensureMember(context, workspace, user, mia, 'member');
  const team = await ensureTeam(context, workspace, user, {
    key: 'operations',
    name: 'Operations',
    description: 'Runs orders and suppliers',
    members: [mia.email],
  });
  await ensureTable(context, workspace, user, { template: 'contacts', teamId: team.id, rows: 20 });
  await ensureTable(context, workspace, user, { template: 'orders', teamId: team.id, rows: 20 });
  await ensureChats(context, workspace, user, { count: 3, turns: 2 });
  const projectId = await ensureProject(context, workspace, user, {
    name: 'Spring launch',
    instructions: 'Keep answers short and cite the launch checklist.',
    members: [mia.email],
    knowledge: [
      { title: 'Launch checklist', content: '1. Confirm suppliers\n2. Update price list\n3. Brief the shop team' },
    ],
  });
  await ensureChats(context, workspace, user, { count: 1, turns: 1, projectId, key: 'project' });
  for (const name of ['skill', 'agent']) await runGenerator(context, target, name, {});
  return target;
}

export const scenarios: Scenario[] = [
  {
    name: 'agent-builder',
    description:
      'People Ops team, sample policies, reviewed and draft skills, inactive setup and active manual agent. No automatic work or provider calls.',
    run: seedAgentBuilder,
  },
  {
    name: 'empty',
    description: 'Signed-in owner with one ready workspace and no content (empty states).',
    async run(context, options) {
      await ensureWorkspace(context, await owner(context), {
        slug: text(options.workspace, 'seed-empty'),
        name: 'Seed Empty',
        scenario: 'empty',
      });
    },
  },
  {
    name: 'basic',
    description: 'Owner plus one member, a team, two tables with 20 rows, chats, a project, a skill, and an agent.',
    async run(context, options) {
      await basic(context, options);
    },
  },
  {
    name: 'rich',
    description:
      'Every generator: varied roles and teams, four tables, long chats, project chats, skills, agents and tasks, workflows and runs, knowledge, integrations.',
    async run(context, options) {
      const target = await basic(context, options, 'seed-rich', 'rich', 'Seed Rich');
      const { workspace, owner: user } = target;
      for (const person of [people.admin, people.manager, people.outsider]) {
        const added = await ensureUser(context, person.email, person.name);
        await ensureMember(context, workspace, user, added, person === people.admin ? 'admin' : 'member');
      }
      const sales = await ensureTeam(context, workspace, user, {
        key: 'sales',
        name: 'Sales',
        description: 'Owns customer relationships',
        managers: [people.manager.email],
        members: [people.member.email],
      });
      await ensureTable(context, workspace, user, { template: 'inventory', teamId: workspace.teams[0]!.id, rows: 40 });
      await ensureTable(context, workspace, user, { template: 'tickets', teamId: workspace.teams[0]!.id, rows: 60 });
      await ensureTable(context, workspace, user, {
        template: 'contacts',
        label: 'Sales leads',
        teamId: sales.id,
        rows: 60,
      });
      await ensureChats(context, workspace, user, { count: 4, turns: 6, key: 'long' });
      const mia = context.manifest.users[people.member.email]!;
      await ensureChats(context, workspace, mia, { count: 2, turns: 2, key: 'member' });
      for (const name of ['workflow', 'knowledge', 'integrations', 'files'])
        await runGenerator(context, target, name, {});
      await runGenerator(context, target, 'tasks', { count: '3' });
      const second = await ensureWorkspace(context, user, {
        slug: 'seed-rich-sandbox',
        name: 'Seed Sandbox',
        scenario: 'rich',
      });
      await ensureTeam(context, second, user, { key: 'sandbox', name: 'Sandbox' });
      await ensureChats(context, second, user, { count: 1, turns: 1 });
    },
  },
  {
    name: 'large',
    description: 'Volume for loading and pagination: thousands of rows and many chats.',
    async run(context, options) {
      const user = await owner(context);
      const workspace = await ensureWorkspace(context, user, {
        slug: text(options.workspace, 'seed-large'),
        name: 'Seed Large',
        scenario: 'large',
      });
      const team = await ensureTeam(context, workspace, user, { key: 'operations', name: 'Operations' });
      await ensureTable(context, workspace, user, {
        template: 'contacts',
        teamId: team.id,
        rows: number(options.rows, 2000),
      });
      await ensureTable(context, workspace, user, {
        template: 'orders',
        teamId: team.id,
        rows: number(options.rows, 2000) / 2,
      });
      await ensureChats(context, workspace, user, { count: number(options.chats, 60), turns: 1, key: 'volume' });
      await ensureChats(context, workspace, user, { count: 1, turns: number(options.turns, 40), key: 'long' });
    },
  },
  {
    name: 'access',
    description: 'Differing roles, teams, and grants (one granted, one revoked) for permission UI.',
    async run(context, options) {
      const user = await owner(context);
      const workspace = await ensureWorkspace(context, user, {
        slug: text(options.workspace, 'seed-access'),
        name: 'Seed Access',
        scenario: 'access',
      });
      const added: Record<string, ManifestUser> = {};
      for (const [key, person] of Object.entries(people))
        if (key !== 'owner') added[key] = await ensureUser(context, person.email, person.name);
      await ensureMember(context, workspace, user, added.admin!, 'admin');
      for (const key of ['manager', 'member', 'outsider'])
        await ensureMember(context, workspace, user, added[key]!, 'member');
      const operations = await ensureTeam(context, workspace, user, {
        key: 'operations',
        name: 'Operations',
        members: [people.member.email],
      });
      const sales = await ensureTeam(context, workspace, user, {
        key: 'sales',
        name: 'Sales',
        managers: [people.manager.email],
      });
      const orders = await ensureTable(context, workspace, user, {
        template: 'orders',
        teamId: operations.id,
        rows: 10,
      });
      const contacts = await ensureTable(context, workspace, user, {
        template: 'contacts',
        teamId: operations.id,
        rows: 10,
      });
      await context.governance.setGrant(workspace.id, user.id, {
        teamId: sales.id,
        target: { kind: 'table', id: orders.tableId, permission: 'table.row.read' },
        granted: true,
      });
      await context.governance.setGrant(workspace.id, user.id, {
        teamId: sales.id,
        target: { kind: 'table', id: contacts.tableId, permission: 'table.row.read' },
        granted: true,
      });
      await context.governance.setGrant(workspace.id, user.id, {
        teamId: sales.id,
        target: { kind: 'table', id: contacts.tableId, permission: 'table.row.read' },
        granted: false,
      });
      await ensureTable(context, workspace, user, {
        template: 'inventory',
        label: 'Sales pipeline',
        teamId: sales.id,
        rows: 10,
      });
    },
  },
];

export async function runGenerator(context: SeedContext, target: Target, name: string, options: Options) {
  const generator = generators.find(item => item.name === name);
  if (!generator) throw new Error(`Unknown generator ${name}. Run \`pnpm seed --list\`.`);
  context.log(`→ ${name} in ${target.workspace.slug}`);
  await generator.run(context, target, options);
}
