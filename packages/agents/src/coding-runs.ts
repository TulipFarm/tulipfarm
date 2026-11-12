import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HumanActor } from '@tulipfarm/access';
import type { ExecutionBackend, ExecutionConfiguration, ExecutionSecret } from '@tulipfarm/execution-contract';
import { runIsolated } from './chat-execution.ts';

export const codingAgents = ['claude-code', 'codex', 'copilot'] as const;
export type CodingAgent = (typeof codingAgents)[number];
export type CodingPlanProvider = 'claude' | 'chatgpt' | 'copilot';

/** Each agent runs only on its vendor's plan, from the backend image of the same name. */
export const codingAgentProviders: Record<CodingAgent, CodingPlanProvider> = {
  'claude-code': 'claude',
  codex: 'chatgpt',
  copilot: 'copilot',
};
const agentLabels: Record<CodingAgent, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot CLI',
};
const providerLabels: Record<CodingPlanProvider, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  copilot: 'GitHub Copilot',
};
export const codingRunLimitMs = 30 * 60 * 1000;
const outputBytes = 1024 * 1024;
const diffBytes = 512 * 1024;
const shownDiffBytes = 16 * 1024;
const messageBytes = 16 * 1024;
const marker = 'TULIPFARM_CODING_RUN ';

const branchSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine(
    value =>
      !value.startsWith('-') &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.endsWith('.lock') &&
      !value.includes('..') &&
      !value.includes('//'),
    'Expected a branch name',
  );
export const codingRunCallSchema = z.strictObject({
  tool: z.literal('coding.run'),
  repository: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
    .refine(value => !['.', '..'].includes(value.split('/')[1]!), 'Expected owner/name')
    .describe('GitHub repository as owner/name.'),
  task: z.string().trim().min(1).max(16000).describe('What the coding agent should do, in full.'),
  agent: z.enum(codingAgents).describe('claude-code runs on Claude, codex on ChatGPT and copilot on GitHub Copilot.'),
  branch: branchSchema.optional().describe('Branch to start from. Defaults to the repository default branch.'),
});
export type CodingRunCall = z.infer<typeof codingRunCallSchema>;

/** A plan connection the member may use, with a current token. */
export type CodingRunPlan = { connectionId: string; ownerMembershipId: string; token: string };
export type CodingRunApproval = {
  workspaceId: string;
  actor: HumanActor;
  conversationId: string;
  turnId: string;
  callId: string;
  repository: string;
  branch: string | null;
  agent: CodingAgent;
  task: string;
  /** Whose plan pays for the agent's model use. */
  planOwnerMembershipId: string;
  /** Digest of the exact run the member approves. */
  digest: string;
};
export type CodingRunServices = {
  /** The first eligible plan of `provider` for the member, in the subscription resolver's order, or null. */
  plan(workspaceId: string, membershipId: string, provider: CodingPlanProvider): Promise<CodingRunPlan | null>;
  /** Whether the member could use any plan of `provider`, without reading a token. */
  hasPlan(workspaceId: string, membershipId: string, provider: CodingPlanProvider): Promise<boolean>;
  /** The token of the personal GitHub account selected for this chat, or null when none is. */
  github(
    workspaceId: string,
    actor: HumanActor,
    origin: { conversationId: string; turnId: string },
  ): Promise<string | null>;
  /** The member's decision on the exact run; `waiting` until they decide. */
  approve(request: CodingRunApproval): Promise<'approved' | 'rejected' | 'waiting'>;
  /** Whether the workspace's `coding-runs` flag is on. */
  enabled(workspaceId: string): Promise<boolean>;
};

export type CodingRunContext = {
  workspaceId: string;
  actor: HumanActor;
  conversationId: string;
  turnId: string;
  callId: string;
  signal?: AbortSignal | undefined;
};
export type CodingRunResult =
  | { status: 'plan-required'; message: string }
  | { status: 'github-account-required'; instruction: string }
  | { status: 'awaiting-approval' | 'rejected' }
  | {
      status: 'completed' | 'failed' | 'timed-out' | 'cancelled' | 'clone-failed';
      exitCode?: number;
      message: string;
      files: string[];
      diff: string;
      diffTruncated: boolean;
      /** The whole diff, up to 512 KiB, for saving as a chat file. */
      fullDiff: string;
      log?: string;
    };

const summarySchema = z.object({
  stage: z.enum(['clone', 'agent', 'done']),
  exitCode: z.number().int().nullable(),
  message: z.string(),
  files: z.array(z.string()),
  diff: z.string(),
  diffTruncated: z.boolean(),
  log: z.string(),
});

const commands: Record<CodingAgent, string> = {
  'claude-code':
    'printf %s "$task" | IS_SANDBOX=1 claude -p --output-format json --dangerously-skip-permissions >"$out/agent.json" 2>"$out/agent.log"',
  codex:
    'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --output-last-message "$out/message.txt" -- "$task" >"$out/agent.log" 2>&1 </dev/null',
  copilot: 'copilot --prompt="$task" --allow-all-tools >"$out/message.txt" 2>"$out/agent.log" </dev/null',
};

// Node reads the run's files, so no other tool is needed in the image; it prints one capped JSON line.
const summary = `
const fs = require('node:fs');
const [out, stage, agent] = process.argv.slice(1);
const read = (name, bytes) => { try { const b = fs.readFileSync(out + '/' + name); return [b.subarray(0, bytes).toString('utf8'), b.length > bytes]; } catch { return ['', false]; } };
const tail = (name, bytes) => { try { const b = fs.readFileSync(out + '/' + name); return b.subarray(Math.max(0, b.length - bytes)).toString('utf8'); } catch { return ''; } };
let message = '';
if (agent === 'claude-code') { try { const r = JSON.parse(read('agent.json', ${outputBytes})[0]); message = typeof r.result === 'string' ? r.result : ''; } catch {} }
else message = read('message.txt', ${messageBytes})[0];
const exit = read('agent.exit', 16)[0].trim();
const [diff, diffTruncated] = read('diff.patch', ${diffBytes});
process.stdout.write(${JSON.stringify(marker)} + JSON.stringify({
  stage, exitCode: exit === '' ? null : Number(exit), message: message.slice(0, ${messageBytes}),
  files: read('files.txt', 65536)[0].split('\\n').filter(Boolean).slice(0, 500), diff, diffTruncated,
  log: stage === 'clone' ? tail('clone.log', 2048) : tail('agent.log', 2048),
}) + '\\n');
`;

/**
 * The run script. Its arguments are the repository, task, branch (or empty), agent and the agent's time limit in
 * seconds; none is ever interpolated. The agent stops before the job does, so the diff is still collected.
 */
export function codingRunScript(agent: CodingAgent) {
  return [
    'repo=$1 task=$2 branch=$3 agent=$4 limit=$5',
    'work=$PWD out=$PWD/.tulipfarm-run',
    'mkdir -p "$out"',
    'export GIT_TERMINAL_PROMPT=0',
    'stage=clone',
    'args=(clone --quiet --no-tags)',
    'if [ -n "$branch" ]; then args+=(--branch "$branch" --single-branch); fi',
    'if git "${args[@]}" -- "https://github.com/$repo.git" "$work/repo" >"$out/clone.log" 2>&1; then',
    '  cd "$work/repo"',
    '  start=$(git rev-parse HEAD)',
    '  stage=agent',
    `  run=${shellQuote(commands[agent])}`,
    '  export task out',
    '  timeout --kill-after=10 "$limit" bash -c "$run"',
    '  echo $? >"$out/agent.exit"',
    '  git add --all --intent-to-add . >/dev/null 2>&1',
    '  git -c core.quotePath=false diff --binary "$start" >"$out/diff.patch" 2>/dev/null',
    '  git -c core.quotePath=false diff --name-only "$start" >"$out/files.txt" 2>/dev/null',
    '  stage=done',
    'fi',
    `node -e ${shellQuote(summary)} "$out" "$stage" "$agent"`,
  ].join('\n');
}
function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Held secrets for one run. Only placeholders enter the machine; the backend's egress adds the real values. */
export function codingRunSecrets(agent: CodingAgent, planToken: string, githubToken: string): ExecutionSecret[] {
  const git: ExecutionSecret = {
    name: 'git',
    value: Buffer.from(`x-access-token:${githubToken}`).toString('base64'),
    hosts: ['github.com'],
    header: 'Authorization',
    format: 'Basic {value}',
  };
  const plan: Record<CodingAgent, ExecutionSecret> = {
    'claude-code': {
      name: 'plan',
      value: planToken,
      env: 'CLAUDE_CODE_OAUTH_TOKEN',
      hosts: ['api.anthropic.com'],
      header: 'Authorization',
      format: 'Bearer {value}',
    },
    // The member's ChatGPT plan token is issued for the OpenAI API, so Codex runs in API mode against it.
    codex: {
      name: 'plan',
      value: planToken,
      env: 'CODEX_API_KEY',
      hosts: ['api.openai.com'],
      header: 'Authorization',
      format: 'Bearer {value}',
    },
    copilot: {
      name: 'plan',
      value: planToken,
      env: 'COPILOT_GITHUB_TOKEN',
      hosts: ['api.github.com', 'api.githubcopilot.com', '*.githubcopilot.com'],
      header: 'Authorization',
      format: 'Bearer {value}',
    },
  };
  return [git, plan[agent]];
}

export function codingRunDigest(call: CodingRunCall, planOwnerMembershipId: string) {
  return createHash('sha256')
    .update(JSON.stringify([call.repository, call.branch ?? null, call.agent, call.task.trim(), planOwnerMembershipId]))
    .digest('hex');
}

/** What the member is told when no plan of the agent's provider is theirs to use. */
export const planRequiredMessage = (agent: CodingAgent) =>
  `Connect your ${providerLabels[codingAgentProviders[agent]]} plan in Settings → Models to use ${agentLabels[agent]}.`;

type RunnableConfiguration = Exclude<ExecutionConfiguration, { mode: 'off' }>;

export type CodingRuns = ReturnType<typeof createCodingRuns>;

/**
 * Runs a vendor coding agent on a GitHub repository in a fresh machine, on the member's own plan, after approval.
 * Nothing is pushed; the result carries the agent's final message, the changed files and the diff.
 */
export function createCodingRuns(
  backend: ExecutionBackend,
  configuration: RunnableConfiguration,
  services: CodingRunServices,
) {
  const { capabilities, templates = [] } = backend.descriptor;
  const agents = capabilities.secrets ? codingAgents.filter(agent => templates.includes(agent)) : [];

  return {
    agents,
    /** Whether chat offers `coding.run` to the member: flag on, and a plan for an agent the backend can start. */
    async offered(workspaceId: string, membershipId: string) {
      if (!agents.length || !(await services.enabled(workspaceId))) return false;
      for (const agent of agents)
        if (await services.hasPlan(workspaceId, membershipId, codingAgentProviders[agent])) return true;
      return false;
    },
    async run(context: CodingRunContext, call: CodingRunCall): Promise<CodingRunResult> {
      const { workspaceId, actor, conversationId } = context;
      if (!agents.includes(call.agent) || !(await services.enabled(workspaceId)))
        throw new Error('coding-run-unavailable');
      const provider = codingAgentProviders[call.agent];
      const plan = await services.plan(workspaceId, actor.membershipId, provider);
      if (!plan) return { status: 'plan-required', message: planRequiredMessage(call.agent) };
      const decision = await services.approve({
        workspaceId,
        actor,
        conversationId,
        turnId: context.turnId,
        callId: context.callId,
        repository: call.repository,
        branch: call.branch ?? null,
        agent: call.agent,
        task: call.task,
        planOwnerMembershipId: plan.ownerMembershipId,
        digest: codingRunDigest(call, plan.ownerMembershipId),
      });
      if (decision !== 'approved') return { status: decision === 'waiting' ? 'awaiting-approval' : 'rejected' };
      const github = await services.github(workspaceId, actor, { conversationId, turnId: context.turnId });
      if (!github)
        return {
          status: 'github-account-required',
          instruction:
            'Ask the person to choose a personal GitHub account for this chat with github.personal.account, then run again.',
        };
      const timeoutMs = Math.min(codingRunLimitMs, configuration.policy.limits.jobTimeoutSeconds * 1000);
      // Clone and diff share the job's time with the agent.
      const agentSeconds = Math.max(60, Math.floor(timeoutMs / 1000) - Math.min(300, Math.floor(timeoutMs / 4000)));
      const result = await runIsolated(
        backend,
        configuration,
        {
          areaId: conversationId,
          command: {
            program: 'bash',
            args: [
              '-c',
              codingRunScript(call.agent),
              'coding-run',
              call.repository,
              call.task,
              call.branch ?? '',
              call.agent,
              String(agentSeconds),
            ],
          },
          timeoutMs,
          template: call.agent,
          secrets: codingRunSecrets(call.agent, plan.token, github),
          outputBytes,
        },
        context.signal,
      );
      const line = result.stdout.split('\n').find(item => item.startsWith(marker));
      const parsed = line ? summarySchema.safeParse(JSON.parse(line.slice(marker.length))) : undefined;
      if (!parsed?.success)
        return {
          status: result.state === 'timed-out' || result.state === 'cancelled' ? result.state : 'failed',
          ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
          message: '',
          files: [],
          diff: '',
          diffTruncated: false,
          fullDiff: '',
          log: result.stderr.slice(-2048),
        };
      const value = parsed.data;
      const bytes = Buffer.from(value.diff);
      const shown = bytes.subarray(0, shownDiffBytes).toString('utf8');
      return {
        status:
          value.stage === 'clone'
            ? 'clone-failed'
            : value.exitCode === 124 || value.exitCode === 137
              ? 'timed-out'
              : value.exitCode === 0
                ? 'completed'
                : 'failed',
        ...(value.exitCode === null ? {} : { exitCode: value.exitCode }),
        message: value.message,
        files: value.files,
        diff: shown,
        diffTruncated: value.diffTruncated || bytes.length > shownDiffBytes,
        fullDiff: value.diff,
        ...(value.exitCode === 0 ? {} : { log: value.log }),
      };
    },
  };
}
