import { Context } from '@temporalio/activity';
import { Client, Connection } from '@temporalio/client';
import { temporalConnectionOptions } from '@tulipfarm/config/temporal';
import type { ExecutionBackend, ExecutionConfiguration } from '@tulipfarm/execution-contract';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
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
import { codingAgentLabels, type CodingAgent } from '@tulipfarm/agents/coding-run-contracts';
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

export function createCodeSessionActivities(
  runtime: ConversationRuntime,
  coding?: {
    backend: ExecutionBackend;
    configuration: Exclude<ExecutionConfiguration, { mode: 'off' }>;
  },
): CodeSessionActivities {
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

      const prompt = buildStagePrompt(stage, session, context);
      const templateByAgent: Record<CodingAgent, string> = {
        'claude-code': 'claude-code',
        codex: 'codex',
        copilot: 'copilot',
      };
      const commandByAgent: Record<CodingAgent, { program: string; args: string[] }> = {
        'claude-code': { program: 'claude', args: ['-p', prompt] },
        codex: { program: 'codex', args: ['exec', prompt] },
        copilot: { program: 'copilot', args: ['-p', prompt] },
      };
      const heartbeatTimer = setInterval(() => {
        Context.current().heartbeat({ stage, sessionId });
      }, 30_000);
      let result;
      try {
        result = await runIsolated(coding.backend, coding.configuration, {
          workspaceId,
          areaId: sessionId,
          template: templateByAgent[session.agent],
          command: commandByAgent[session.agent],
          timeoutMs: 30 * 60_000,
        });
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
      const reason = `GitHub pull request creation (${draft ? 'draft' : 'ready'}) for ${session.repository}@${session.sessionBranch} requires member GitHub write-token integration.`;
      await recordCodeSessionStep(runtime, workspaceId, {
        sessionId,
        stage: 'pull-request',
        agent: session.agent,
        outcome: 'blocked',
        finalMessage: reason,
        activeMs: 0,
      });
      return { status: 'blocked', reason };
    },

    async runCodeSessionReviews(workspaceId, sessionId) {
      const startedAt = Date.now();
      const session = await readCodeSessionSystem(runtime, workspaceId, sessionId);
      const reviewers = session.reviewers.length > 0 ? session.reviewers : [{ agent: session.agent }];
      const verdicts: CodeSessionReviewVerdict[] = reviewers.map(reviewer => ({
        reviewerAgent: reviewer.agent,
        reviewerModel: reviewer.model,
        verdict: 'changes-requested',
        summary: `Automated ${codingAgentLabels[reviewer.agent]} review requires a live pull request diff.`,
      }));
      const activeMs = Date.now() - startedAt;
      await recordCodeSessionStep(runtime, workspaceId, {
        sessionId,
        stage: 'review',
        agent: session.agent,
        outcome: 'blocked',
        finalMessage: verdicts.map(v => v.summary).join('\n'),
        activeMs,
      });
      return { verdicts, approved: false, activeMs };
    },

    async mergeCodeSessionPullRequest(workspaceId, sessionId) {
      const session = await readCodeSessionSystem(runtime, workspaceId, sessionId);
      const message = `Merging ${session.sessionBranch} into ${session.baseBranch} requires member GitHub write-token integration.`;
      await recordCodeSessionStep(runtime, workspaceId, {
        sessionId,
        stage: 'merging',
        agent: session.agent,
        outcome: 'blocked',
        finalMessage: message,
        activeMs: 0,
      });
      return { status: 'blocked', message };
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
