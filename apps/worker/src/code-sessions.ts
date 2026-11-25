import { Context } from '@temporalio/activity';
import { Client, Connection } from '@temporalio/client';
import type { HumanActor } from '@tulipfarm/access';
import { temporalConnectionOptions } from '@tulipfarm/config/temporal';
import type { ExecutionBackend, ExecutionConfiguration } from '@tulipfarm/execution-contract';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { runIsolated } from '@tulipfarm/agents/chat-execution';
import {
  CODE_SESSION_COMMIT_TRAILER,
  parseCodeStageMarker,
  type CodeSessionRequestAnswer,
  type CodeSessionReviewVerdict,
  type CodeSessionStageOutcome,
} from '@tulipfarm/agents/code-session-contracts';
import {
  advanceCodeSessionStage,
  appendCodeSessionTerminalChunk,
  openCodeSessionRequest,
  readCodeSessionRequestForWorker,
  readCodeSessionSystem,
  recordCodeSessionStep,
} from '@tulipfarm/agents/code-session-store';
import {
  codingAgentProviders,
  codingRunLimitMs,
  codingRunScript,
  codingRunSecrets,
  planRequiredMessage,
} from '@tulipfarm/agents/coding-runs';
import { codingAgentLabels } from '@tulipfarm/agents/coding-run-contracts';
import { codingRunServices } from './coding-runs.ts';
import { codeSessionSignal, type CodeSessionActivities } from './code-session-workflows.ts';

function buildStagePrompt(
  stage: 'brainstorm' | 'plan' | 'code' | 'verify',
  session: Awaited<ReturnType<typeof readCodeSessionSystem>>,
  context: { answers: string[]; guidance?: string | undefined },
): string {
  const parts = [
    `You are running stage "${stage}" of a TulipFarm code session on ${session.repository}.`,
    `Base branch: ${session.baseBranch}. Session branch: ${session.sessionBranch}.`,
    `Original request:\n${session.request ?? session.title}`,
  ];
  if (context.answers.length > 0) {
    parts.push(`Member answers:\n${context.answers.join('\n\n')}`);
  }
  if (session.planMarkdown && stage !== 'brainstorm') {
    parts.push(`Approved plan:\n${session.planMarkdown}`);
  }
  if (context.guidance) {
    parts.push(`Additional guidance:\n${context.guidance}`);
  }
  if (stage === 'code') {
    parts.push(
      `Commit all changes to ${session.sessionBranch} (never push to ${session.baseBranch}).`,
      `Include this exact trailer at the end of every git commit message:\n\n${CODE_SESSION_COMMIT_TRAILER}`,
    );
  }
  parts.push(
    `Finish by printing one single final line starting with "TULIPFARM_CODE_STAGE " followed by valid JSON matching one of:`,
    `- {"kind":"questions","questions":[{"question":"...","options":[{"number":1,"label":"...","recommended":true}]}]}`,
    `- {"kind":"plan","title":"...","summary":"...","markdown":"..."}`,
    `- {"kind":"done","summary":"...","changedFiles":["..."],"diffSummary":"...","checks":[],"screenshots":[]}`,
    `- {"kind":"blocked","reason":"..."}`,
    `- {"kind":"limit","reason":"...","resetAt":"ISO-8601"}`,
  );
  return parts.join('\n\n');
}

async function resolveOwnerActor(
  runtime: ConversationRuntime,
  workspaceId: string,
  membershipId: string,
): Promise<HumanActor | null> {
  return runtime.transaction(workspaceId, commonCompatibility, async tx => {
    const membershipsTable = qualified(tx.schema, 'tf_memberships');
    const res = await tx.client.query(`SELECT user_id FROM ${membershipsTable} WHERE id = $1 LIMIT 1`, [membershipId]);
    const userId = res.rows[0]?.user_id as string | undefined;
    return userId ? { kind: 'human', membershipId, userId } : null;
  });
}

async function githubApiRequest<T>(
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; message: string }> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'TulipFarm-CodeSessions',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) {
    return { ok: true, status: 204, data: undefined as T };
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'message' in parsed && typeof parsed.message === 'string'
        ? parsed.message
        : `GitHub API returned HTTP ${response.status}.`;
    return { ok: false, status: response.status, message };
  }
  return { ok: true, status: response.status, data: parsed as T };
}

export function createCodeSessionActivities(
  runtime: ConversationRuntime,
  coding?: {
    backend: ExecutionBackend;
    configuration: Exclude<ExecutionConfiguration, { mode: 'off' }>;
  },
): CodeSessionActivities {
  const services = codingRunServices(runtime);

  const resolveGitHubToken = async (
    workspaceId: string,
    session: Awaited<ReturnType<typeof readCodeSessionSystem>>,
  ): Promise<{ token: string; login: string } | null> => {
    const actor = await resolveOwnerActor(runtime, workspaceId, session.ownerMembershipId);
    if (!actor) return null;
    return services.github(
      workspaceId,
      actor,
      { conversationId: session.originConversationId ?? session.id, turnId: session.id, runId: session.id },
      session.githubAccount,
    );
  };

  return {
    async loadCodeSession(workspaceId, sessionId) {
      return readCodeSessionSystem(runtime, workspaceId, sessionId);
    },

    async runCodeSessionStage(workspaceId, sessionId, stage, context) {
      const startedAt = Date.now();
      const session = await readCodeSessionSystem(runtime, workspaceId, sessionId);
      Context.current().heartbeat({ stage, sessionId });
      await appendCodeSessionTerminalChunk(runtime, workspaceId, {
        sessionId,
        stage,
        stream: 'system',
        chunk: `[${stage}] Starting ${codingAgentLabels[session.agent]} on ${session.repository} (${session.sessionBranch})…`,
      });

      if (!coding) {
        const outcome: CodeSessionStageOutcome = {
          kind: 'blocked',
          reason:
            'Code execution sandbox (Spawnbox) is not configured on this server. Configure execution to run coding agents.',
        };
        await appendCodeSessionTerminalChunk(runtime, workspaceId, {
          sessionId,
          stage,
          stream: 'stderr',
          chunk: outcome.reason,
        });
        await recordCodeSessionStep(runtime, workspaceId, {
          sessionId,
          stage,
          agent: session.agent,
          outcome: 'blocked',
          finalMessage: outcome.reason,
          activeMs: Date.now() - startedAt,
        });
        return { outcome, activeMs: Date.now() - startedAt };
      }

      const plan = await services.plan(workspaceId, session.ownerMembershipId, codingAgentProviders[session.agent]);
      if (!plan) {
        const reason = planRequiredMessage(session.agent);
        await appendCodeSessionTerminalChunk(runtime, workspaceId, {
          sessionId,
          stage,
          stream: 'stderr',
          chunk: reason,
        });
        await recordCodeSessionStep(runtime, workspaceId, {
          sessionId,
          stage,
          agent: session.agent,
          outcome: 'blocked',
          finalMessage: reason,
          activeMs: Date.now() - startedAt,
        });
        return { outcome: { kind: 'blocked', reason }, activeMs: Date.now() - startedAt };
      }
      const github = await resolveGitHubToken(workspaceId, session);
      if (!github) {
        const reason =
          'Connect a personal GitHub account and enable Use for coding in Settings → Integrations before running a code session.';
        await appendCodeSessionTerminalChunk(runtime, workspaceId, {
          sessionId,
          stage,
          stream: 'stderr',
          chunk: reason,
        });
        await recordCodeSessionStep(runtime, workspaceId, {
          sessionId,
          stage,
          agent: session.agent,
          outcome: 'blocked',
          finalMessage: reason,
          activeMs: Date.now() - startedAt,
        });
        return { outcome: { kind: 'blocked', reason }, activeMs: Date.now() - startedAt };
      }

      const prompt = buildStagePrompt(stage, session, context);
      const cloneBranch = stage === 'verify' ? session.sessionBranch : session.baseBranch;
      const pushBranch = stage === 'code' ? session.sessionBranch : '';
      const commitMessage = `${session.title}\n\n${CODE_SESSION_COMMIT_TRAILER}`;
      const limitSeconds = String(Math.floor(codingRunLimitMs / 1000) - 60);
      const heartbeatTimer = setInterval(() => {
        Context.current().heartbeat({ stage, sessionId });
      }, 30_000);
      let result;
      try {
        result = await runIsolated(
          coding.backend,
          coding.configuration,
          {
            workspaceId,
            areaId: sessionId,
            template: session.agent,
            command: {
              program: 'bash',
              args: [
                '-c',
                codingRunScript(session.agent),
                '--',
                session.repository,
                prompt,
                cloneBranch,
                session.agent,
                limitSeconds,
                pushBranch,
                github.login,
                `${github.login}@users.noreply.github.com`,
                commitMessage,
              ],
            },
            secrets: codingRunSecrets(session.agent, plan.token, github.token),
            timeoutMs: codingRunLimitMs,
          },
          Context.current().cancellationSignal,
        );
      } finally {
        clearInterval(heartbeatTimer);
      }

      const activeMs = Date.now() - startedAt;
      if (result.stdout.trim()) {
        await appendCodeSessionTerminalChunk(runtime, workspaceId, {
          sessionId,
          stage,
          stream: 'stdout',
          chunk: result.stdout.trim(),
        });
      }
      if (result.stderr.trim()) {
        await appendCodeSessionTerminalChunk(runtime, workspaceId, {
          sessionId,
          stage,
          stream: 'stderr',
          chunk: result.stderr.trim(),
        });
      }
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      const succeeded = result.state === 'completed' && result.exitCode === 0;
      const parsed = parseCodeStageMarker(combinedOutput);
      const outcome: CodeSessionStageOutcome = (() => {
        if (parsed?.kind === 'limit') return parsed;
        if (!succeeded) {
          return {
            kind: 'blocked',
            reason: combinedOutput.trim().slice(-2000) || `Stage ${stage} exited with state ${result.state}.`,
          };
        }
        if (stage === 'verify') {
          if (parsed?.kind === 'done') return parsed;
          if (parsed?.kind === 'blocked') return parsed;
          return {
            kind: 'blocked',
            reason:
              combinedOutput.trim().slice(-2000) || 'Verification finished without a structured verification result.',
          };
        }
        if (parsed) return parsed;
        return {
          kind: 'done',
          summary: combinedOutput.trim().slice(-2000) || `${stage} completed.`,
          changedFiles: [],
          checks: [],
          screenshots: [],
        };
      })();

      await recordCodeSessionStep(runtime, workspaceId, {
        sessionId,
        stage,
        agent: session.agent,
        outcome: outcome.kind,
        finalMessage:
          outcome.kind === 'done'
            ? outcome.summary
            : outcome.kind === 'plan'
              ? outcome.summary
              : outcome.kind === 'blocked' || outcome.kind === 'limit'
                ? outcome.reason
                : `Asked ${outcome.questions.length} question(s).`,
        changedFiles: outcome.kind === 'done' ? outcome.changedFiles : [],
        diffSummary: outcome.kind === 'done' ? (outcome.diffSummary ?? null) : null,
        checks: outcome.kind === 'done' ? outcome.checks : [],
        screenshots: outcome.kind === 'done' ? outcome.screenshots : [],
        activeMs,
      });

      return { outcome, activeMs };
    },

    async openCodeSessionInboxRequest(workspaceId, sessionId, payload) {
      return openCodeSessionRequest(runtime, workspaceId, sessionId, payload);
    },

    async readCodeSessionRequestState(workspaceId, sessionId, requestId) {
      return readCodeSessionRequestForWorker(runtime, workspaceId, sessionId, requestId);
    },

    async advanceCodeSession(workspaceId, sessionId, patch) {
      return advanceCodeSessionStage(runtime, workspaceId, sessionId, {
        ...patch,
        usageLimitUntil: patch.usageLimitUntil ? new Date(patch.usageLimitUntil) : null,
      });
    },

    async openCodeSessionPullRequest(workspaceId, sessionId, draft) {
      const session = await readCodeSessionSystem(runtime, workspaceId, sessionId);
      const github = await resolveGitHubToken(workspaceId, session);
      if (!github) {
        const reason = 'Connect a personal GitHub account with repo write access to open pull requests.';
        await recordCodeSessionStep(runtime, workspaceId, {
          sessionId,
          stage: 'pull-request',
          agent: session.agent,
          outcome: 'blocked',
          finalMessage: reason,
          activeMs: 0,
        });
        return { status: 'blocked', reason };
      }

      const bodyLines = [
        session.summary || session.title,
        '',
        session.planMarkdown ? `### Plan\n${session.planMarkdown.slice(0, 6000)}` : '',
        '',
        CODE_SESSION_COMMIT_TRAILER,
      ]
        .filter(Boolean)
        .join('\n');

      const created = await githubApiRequest<{ number: number; html_url: string }>(
        github.token,
        'POST',
        `/repos/${session.repository}/pulls`,
        {
          title: session.title,
          head: session.sessionBranch,
          base: session.baseBranch,
          body: bodyLines,
          draft,
        },
      );
      if (!created.ok) {
        const reason = `GitHub could not open the pull request: ${created.message}`;
        await appendCodeSessionTerminalChunk(runtime, workspaceId, {
          sessionId,
          stage: 'pull-request',
          stream: 'stderr',
          chunk: reason,
        });
        await recordCodeSessionStep(runtime, workspaceId, {
          sessionId,
          stage: 'pull-request',
          agent: session.agent,
          outcome: 'blocked',
          finalMessage: reason,
          activeMs: 0,
        });
        return { status: 'blocked', reason };
      }

      await appendCodeSessionTerminalChunk(runtime, workspaceId, {
        sessionId,
        stage: 'pull-request',
        stream: 'system',
        chunk: `Opened ${draft ? 'draft ' : ''}PR #${created.data.number}: ${created.data.html_url}`,
      });
      await recordCodeSessionStep(runtime, workspaceId, {
        sessionId,
        stage: 'pull-request',
        agent: session.agent,
        outcome: 'done',
        finalMessage: `Opened PR #${created.data.number}: ${created.data.html_url}`,
        activeMs: 0,
      });
      return { status: 'opened', number: created.data.number, url: created.data.html_url };
    },

    async runCodeSessionReviews(workspaceId, sessionId) {
      const startedAt = Date.now();
      const session = await readCodeSessionSystem(runtime, workspaceId, sessionId);
      const reviewers = session.reviewers.length > 0 ? session.reviewers : [{ agent: session.agent }];
      const github = await resolveGitHubToken(workspaceId, session);
      const verdicts: CodeSessionReviewVerdict[] = [];

      for (const reviewer of reviewers) {
        if (!coding || !github) {
          verdicts.push({
            reviewerAgent: reviewer.agent,
            reviewerModel: reviewer.model,
            verdict: 'changes-requested',
            summary: 'Review requires a configured execution sandbox and connected GitHub account.',
          });
          continue;
        }
        const plan = await services.plan(workspaceId, session.ownerMembershipId, codingAgentProviders[reviewer.agent]);
        if (!plan) {
          verdicts.push({
            reviewerAgent: reviewer.agent,
            reviewerModel: reviewer.model,
            verdict: 'changes-requested',
            summary: planRequiredMessage(reviewer.agent),
          });
          continue;
        }
        const reviewPrompt = [
          `Review branch "${session.sessionBranch}" against "${session.baseBranch}" in ${session.repository}.`,
          `Inspect the git diff ("git diff origin/${session.baseBranch}...HEAD") for bugs, security flaws, or missing tests.`,
          'Emit a single final line: TULIPFARM_CODE_STAGE {"kind":"done","summary":"<concise review>"} if approved, or TULIPFARM_CODE_STAGE {"kind":"blocked","reason":"<issues to fix>"} if changes are requested.',
        ].join('\n');
        const limitSeconds = String(Math.floor(codingRunLimitMs / 1000) - 60);
        const result = await runIsolated(
          coding.backend,
          coding.configuration,
          {
            workspaceId,
            areaId: sessionId,
            template: reviewer.agent,
            command: {
              program: 'bash',
              args: [
                '-c',
                codingRunScript(reviewer.agent),
                '--',
                session.repository,
                reviewPrompt,
                session.sessionBranch,
                reviewer.agent,
                limitSeconds,
                '',
                '',
                '',
                '',
              ],
            },
            secrets: codingRunSecrets(reviewer.agent, plan.token, github.token),
            timeoutMs: codingRunLimitMs,
          },
          Context.current().cancellationSignal,
        );
        const combined = `${result.stdout}\n${result.stderr}`;
        const parsed = parseCodeStageMarker(combined);
        const approved = result.state === 'completed' && result.exitCode === 0 && parsed?.kind === 'done';
        const summary =
          parsed?.kind === 'done'
            ? parsed.summary
            : parsed?.kind === 'blocked'
              ? parsed.reason
              : combined.trim().slice(-1200) || `Review by ${codingAgentLabels[reviewer.agent]} did not approve.`;
        verdicts.push({
          reviewerAgent: reviewer.agent,
          reviewerModel: reviewer.model,
          verdict: approved ? 'approved' : 'changes-requested',
          summary,
        });
        if (session.pullRequestNumber) {
          const label = `Automated review by ${codingAgentLabels[reviewer.agent]}${reviewer.model ? ` (${reviewer.model})` : ''}`;
          await githubApiRequest(
            github.token,
            'POST',
            `/repos/${session.repository}/pulls/${session.pullRequestNumber}/reviews`,
            {
              event: 'COMMENT',
              body: `**${label}** — ${approved ? 'Approved' : 'Changes requested'}\n\n${summary}`,
            },
          );
        }
      }

      const activeMs = Date.now() - startedAt;
      const allApproved = verdicts.length > 0 && verdicts.every(v => v.verdict === 'approved');
      await recordCodeSessionStep(runtime, workspaceId, {
        sessionId,
        stage: 'review',
        agent: session.agent,
        outcome: allApproved ? 'done' : 'blocked',
        finalMessage: verdicts.map(v => `${codingAgentLabels[v.reviewerAgent]}: ${v.summary}`).join('\n'),
        activeMs,
      });
      return { verdicts, approved: allApproved, activeMs };
    },

    async mergeCodeSessionPullRequest(workspaceId, sessionId) {
      const session = await readCodeSessionSystem(runtime, workspaceId, sessionId);
      if (!session.pullRequestNumber) {
        return { status: 'blocked', message: 'No pull request is linked to this code session.' };
      }
      const github = await resolveGitHubToken(workspaceId, session);
      if (!github) {
        return {
          status: 'blocked',
          message: 'Connect a personal GitHub account with repo write access to merge pull requests.',
        };
      }
      const merged = await githubApiRequest<{ merged: boolean; message: string }>(
        github.token,
        'PUT',
        `/repos/${session.repository}/pulls/${session.pullRequestNumber}/merge`,
        {
          merge_method: 'squash',
          commit_title: `${session.title} (#${session.pullRequestNumber})`,
          commit_message: CODE_SESSION_COMMIT_TRAILER,
        },
      );
      if (!merged.ok) {
        const isConflict = merged.status === 405 || merged.status === 409;
        await recordCodeSessionStep(runtime, workspaceId, {
          sessionId,
          stage: 'merging',
          agent: session.agent,
          outcome: 'blocked',
          finalMessage: merged.message,
          activeMs: 0,
        });
        return { status: isConflict ? 'conflict' : 'blocked', message: merged.message };
      }

      // Best-effort remote session branch cleanup after squash merge.
      await githubApiRequest(
        github.token,
        'DELETE',
        `/repos/${session.repository}/git/refs/heads/${encodeURIComponent(session.sessionBranch)}`,
      );

      const message = `Squash-merged PR #${session.pullRequestNumber} (${session.sessionBranch} into ${session.baseBranch}).`;
      await appendCodeSessionTerminalChunk(runtime, workspaceId, {
        sessionId,
        stage: 'merged',
        stream: 'system',
        chunk: message,
      });
      await recordCodeSessionStep(runtime, workspaceId, {
        sessionId,
        stage: 'merging',
        agent: session.agent,
        outcome: 'done',
        finalMessage: message,
        activeMs: 0,
      });
      return { status: 'merged', message };
    },
  };
}

export function createCodeSessionDispatcher(taskQueue: string) {
  let clientPromise: Promise<Client> | undefined;
  const getClient = () =>
    (clientPromise ??= Connection.connect(temporalConnectionOptions()).then(connection => new Client({ connection })));

  return {
    async start(workspaceId: string, sessionId: string) {
      const client = await getClient();
      const workflowId = `code-session-${sessionId}`;
      try {
        await client.workflow.start('codeSession', {
          taskQueue,
          workflowId,
          args: [{ workspaceId, sessionId }],
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'WorkflowExecutionAlreadyStartedError') return;
        throw error;
      }
    },
    async signalAnswer(sessionId: string, requestId: string, answer: CodeSessionRequestAnswer) {
      const client = await getClient();
      const handle = client.workflow.getHandle(`code-session-${sessionId}`);
      await handle.signal(codeSessionSignal, { kind: 'answer', requestId, answer }).catch(() => undefined);
    },
    async signalStop(sessionId: string) {
      const client = await getClient();
      const handle = client.workflow.getHandle(`code-session-${sessionId}`);
      await handle.signal(codeSessionSignal, { kind: 'stop' }).catch(() => undefined);
    },
  };
}
