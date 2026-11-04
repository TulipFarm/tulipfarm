import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Client, Connection } from '@temporalio/client';
import { AccessDenied } from '@tulipfarm/access';
import { createAgentPlans } from '@tulipfarm/agents/plans';
import { Pool } from 'pg';
import { workspaceRuntime } from '@tulipfarm/workspaces/storage';
import { apiOrigin, loadLocalEnv, SeedRefused, webOrigin } from './env.ts';
import { readManifest } from './manifest.ts';

const usage = `Usage: node apps/dev-seed/src/plan-document-demo.ts [--workspace seed-basic] [--revise]

Creates a plan with a document in an owner chat of a seeded workspace through the real plan service, wakes its
workflow like a chat edit does, and waits until the worker and render worker have saved the document. Run again with
--revise to save revision 2 of the document. Needs the stack from \`pnpm dev\` and a workspace from \`pnpm seed\`.`;

// Section text supports only bold, italic, inline code, links and lists, so the approach has no headings.
const title = 'Launch the Q1 customer onboarding revamp';

const document = {
  summary:
    'Replace the 14-step onboarding checklist with a guided, three-stage flow for new customers starting in Q1. Success means new accounts reach their first completed order within 7 days, up from 41% today to at least 60%, with no rise in support tickets during the first month.',
  approach: [
    'We run the work in three stages so each team can ship without waiting on the others:',
    '',
    '1. **Audit** the current checklist and the last 90 days of support tickets to find where new customers stall.',
    '2. **Build in parallel**: the welcome email series, the in-app guide and the success dashboard are independent, so three owners work on them at the same time.',
    '3. **Pilot** with 20 new accounts for two weeks before turning the flow on for everyone.',
    '',
    '**Guardrails**',
    '',
    '- The old checklist stays available behind a link until the pilot passes.',
    '- Every email is reviewed by support before it is scheduled.',
    '- The dashboard reads from the existing *Orders* and *Contacts* tables; no new data is collected.',
  ].join('\n'),
  risks: [
    {
      risk: 'New customers get both the old checklist emails and the new welcome series during the switchover.',
      mitigation:
        'Pause the old sequence for pilot accounts first, and check the send log daily during the pilot for duplicates.',
    },
    {
      risk: 'The pilot cohort is too small to show a real change in first-order rate within two weeks.',
      mitigation:
        'Pick pilot accounts from the busiest signup week, and extend the pilot by one week if fewer than 12 accounts place an order.',
    },
  ],
  diagrams: [
    {
      key: 'onboarding-flow',
      title: 'New customer onboarding flow',
      caption: 'The three stages a new account moves through after signup.',
      mermaid: [
        'flowchart LR',
        '  signup[Account created] --> welcome[Welcome email day 0]',
        '  welcome --> guide[In-app guide]',
        '  guide --> setup{Profile complete?}',
        '  setup -- Yes --> order[First order placed]',
        '  setup -- No --> nudge[Reminder email day 3]',
        '  nudge --> guide',
        '  order --> success[Success dashboard updated]',
      ].join('\n'),
    },
    {
      key: 'pilot-handoff',
      title: 'Pilot handoff between teams',
      caption: 'Who hands what to whom while the pilot runs.',
      mermaid: [
        'sequenceDiagram',
        '  participant Ops as Operations',
        '  participant CS as Customer success',
        '  participant Sup as Support',
        '  participant Cust as Pilot customer',
        '  Ops->>CS: Share pilot account list',
        '  CS->>Cust: Send welcome series',
        '  Cust->>Sup: Ask a setup question',
        '  Sup-->>CS: Log question as a guide gap',
        '  CS->>Ops: Weekly first-order report',
        '  Ops-->>CS: Go or extend decision',
      ].join('\n'),
    },
  ],
};

const coordinator = { kind: 'coordinator' } as const;
const tasks = [
  {
    key: 'audit',
    title: 'Audit the current onboarding checklist',
    brief: 'Review the 14 checklist steps and 90 days of onboarding support tickets.',
    criteria: ['Each step is marked keep, merge or drop', 'Top 5 stall points are listed with ticket counts'],
    assignee: coordinator,
  },
  {
    key: 'build',
    kind: 'group',
    order: 'parallel',
    title: 'Build the new onboarding pieces',
    dependsOn: ['audit'],
  },
  {
    key: 'emails',
    parent: 'build',
    title: 'Draft the welcome email series',
    brief: 'Three emails: day 0 welcome, day 3 reminder, day 7 check-in.',
    criteria: ['Three emails drafted', 'Support has reviewed each email'],
    assignee: coordinator,
  },
  {
    key: 'guide',
    parent: 'build',
    title: 'Write the in-app guide',
    brief: 'A three-stage guide that replaces the checklist for new accounts.',
    criteria: ['Guide covers profile, first product and first order'],
    assignee: coordinator,
  },
  {
    key: 'dashboard',
    parent: 'build',
    title: 'Set up the onboarding success dashboard',
    brief: 'Track first-order rate within 7 days from the Orders and Contacts tables.',
    criteria: ['Dashboard shows weekly first-order rate for new accounts'],
    assignee: coordinator,
  },
  {
    key: 'pilot',
    title: 'Run a two-week pilot with 20 new accounts',
    criteria: ['20 pilot accounts enrolled', 'Duplicate sends checked daily'],
    dependsOn: ['build'],
    assignee: coordinator,
  },
  {
    key: 'verify',
    title: 'Verify the pilot results before full rollout',
    criteria: ['First-order rate within 7 days is at least 60%', 'Support tickets did not rise'],
    dependsOn: ['pilot'],
    assignee: coordinator,
  },
];
const planning = {
  requirements: [
    {
      key: 'flow',
      description: 'A guided onboarding flow replaces the 14-step checklist.',
      tasks: ['audit', 'emails', 'guide'],
    },
    { key: 'measure', description: 'First-order rate is measured for every new account.', tasks: ['dashboard'] },
    { key: 'pilot', description: 'The flow is proven on a pilot before full rollout.', tasks: ['pilot'] },
  ],
  prerequisites: [],
  verificationTask: 'verify',
};

const revision2 = {
  summary:
    'Replace the 14-step onboarding checklist with a guided, three-stage flow for new customers starting in Q1. Success means new accounts reach their first completed order within 7 days, up from 41% today to at least 60%, with support tickets per new account flat or lower for the first 30 days.',
  risks: [
    document.risks[0]!,
    {
      risk: 'The pilot cohort is too small to show a real change in first-order rate within two weeks.',
      mitigation:
        'Enrol 30 accounts instead of 20 from the two busiest signup weeks, and extend the pilot by one week if fewer than 15 place an order.',
    },
  ],
};

async function main() {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string', default: 'seed-basic' },
      revise: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  loadLocalEnv();
  const manifest = await readManifest(webOrigin(), apiOrigin());
  const workspace = manifest.workspaces[values.workspace];
  if (!workspace) throw new SeedRefused(`Workspace ${values.workspace} is not in .seed/manifest.json. Run pnpm seed.`);
  const owner = manifest.users[workspace.owner];
  if (!owner) throw new SeedRefused(`Owner ${workspace.owner} is not in .seed/manifest.json.`);
  const log = (message: string) => process.stdout.write(`${message}\n`);
  const identity = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=app', max: 2 });
  identity.on('error', () => undefined);
  const runtime = workspaceRuntime(identity);
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
  const temporal = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
  try {
    const plans = createAgentPlans(runtime);
    const chats = workspace.entities.chats ?? [];
    let found: { planId: string; chatId: string } | undefined;
    for (const chat of chats) {
      const list = await plans.list(workspace.id, owner.id, chat.id).catch(error => {
        if (error instanceof AccessDenied) return [];
        throw error;
      });
      const plan = list.find(item => item.title === title);
      if (plan) found = { planId: plan.id, chatId: chat.id };
      if (found) break;
    }
    if (!found) {
      for (const chat of chats) {
        try {
          const receipt = await plans.create(workspace.id, owner.id, chat.id, randomUUID(), {
            title,
            brief: 'Move new Q1 customers to a guided onboarding flow and prove it on a pilot first.',
            execution: 'plan-only',
            planning,
            tasks,
            document,
          });
          found = { planId: receipt.id, chatId: chat.id };
          log(`Created plan ${receipt.id} in chat ${chat.label}.`);
          break;
        } catch (error) {
          if (error instanceof AccessDenied || (error instanceof Error && error.message === 'plan-open')) continue;
          throw error;
        }
      }
      if (!found) throw new Error('No owner chat in this workspace can take a new plan.');
    } else log(`Plan "${title}" already exists: ${found.planId}.`);
    const { planId, chatId } = found;
    if (values.revise) {
      const view = await plans.read(workspace.id, owner.id, planId);
      if (view.document?.summary === revision2.summary) log('Revision 2 is already saved.');
      else {
        await plans.update(workspace.id, owner.id, planId, randomUUID(), {
          expectedVersion: view.version,
          document: revision2,
        });
        log('Saved revision 2 of the document.');
      }
    }
    // The same wake a chat edit sends; the plan step then starts the document rendering.
    await temporal.workflow.signalWithStart('agentPlanStep', {
      workflowId: `agent-plan-v1-${workspace.id}-${planId}`,
      taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
      args: [workspace.id, planId],
      signal: 'wakeAgentPlan',
      signalArgs: [],
      workflowIdConflictPolicy: 'USE_EXISTING',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    });
    const deadline = Date.now() + 180000;
    for (;;) {
      const view = await plans.read(workspace.id, owner.id, planId);
      const render = view.documentRender;
      if (
        render &&
        render.revision === view.contentRevision &&
        render.status !== 'pending' &&
        render.status !== 'rendering'
      ) {
        log(`Document of revision ${render.revision} is ${render.status}${render.error ? ` (${render.error})` : ''}.`);
        if (render.status !== 'ready') process.exitCode = 1;
        break;
      }
      if (Date.now() > deadline) {
        log(`Gave up waiting for the document: ${JSON.stringify(render)}.`);
        process.exitCode = 1;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          workspaceId: workspace.id,
          chatId,
          planId,
          chatUrl: `${manifest.webOrigin}/${workspace.slug}/chat/${chatId}`,
          signInUrl: owner.signInUrl,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await connection.close();
    await runtime.close();
    await identity.end();
  }
}

main().catch(error => {
  process.stderr.write(
    `${error instanceof SeedRefused ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
