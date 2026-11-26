import {
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type {
  CodeSessionRequestAnswer,
  CodeSessionRequestPayload,
  CodeSessionRequestView,
  CodeSessionReviewVerdict,
  CodeSessionStage,
  CodeSessionStageOutcome,
  CodeSessionView,
} from '@tulipfarm/agents/code-session-contracts';
import type { CodingAgent } from '@tulipfarm/agents/coding-run-contracts';

export type CodeSessionSignal =
  | { kind: 'answer'; requestId: string; answer: CodeSessionRequestAnswer }
  | { kind: 'stop' };

export const codeSessionSignal = defineSignal<[CodeSessionSignal]>('codeSessionSignal');

export type CodeSessionActivities = {
  loadCodeSession(workspaceId: string, sessionId: string): Promise<CodeSessionView>;
  runCodeSessionStage(
    workspaceId: string,
    sessionId: string,
    stage: 'brainstorm' | 'plan' | 'code' | 'verify',
    context: { answers: string[]; guidance?: string | undefined },
  ): Promise<{ outcome: CodeSessionStageOutcome; activeMs: number }>;
  openCodeSessionInboxRequest(
    workspaceId: string,
    sessionId: string,
    payload: CodeSessionRequestPayload,
  ): Promise<CodeSessionRequestView>;
  readCodeSessionRequestState(
    workspaceId: string,
    sessionId: string,
    requestId: string,
  ): Promise<{ stage: CodeSessionStage; request: CodeSessionRequestView | null }>;
  advanceCodeSession(
    workspaceId: string,
    sessionId: string,
    patch: {
      stage: CodeSessionStage;
      addActiveMs?: number | undefined;
      fixAttempts?: number | undefined;
      reviewRounds?: number | undefined;
      summary?: string | null | undefined;
      planMarkdown?: string | null | undefined;
      planApproved?: boolean | undefined;
      pullRequestNumber?: number | null | undefined;
      pullRequestUrl?: string | null | undefined;
      usageLimitUntil?: string | null | undefined;
      errorMessage?: string | null | undefined;
      agent?: CodingAgent | undefined;
      addBudgetMs?: number | undefined;
    },
  ): Promise<CodeSessionView>;
  openCodeSessionPullRequest(
    workspaceId: string,
    sessionId: string,
    draft: boolean,
  ): Promise<{ status: 'opened'; number: number; url: string } | { status: 'blocked'; reason: string }>;
  runCodeSessionReviews(
    workspaceId: string,
    sessionId: string,
  ): Promise<{ verdicts: CodeSessionReviewVerdict[]; approved: boolean; activeMs: number }>;
  mergeCodeSessionPullRequest(
    workspaceId: string,
    sessionId: string,
  ): Promise<{ status: 'merged' | 'conflict' | 'blocked'; message: string }>;
};

const MAX_FIX_ATTEMPTS = 3;
const MAX_REVIEW_ROUNDS = 3;

const acts = proxyActivities<CodeSessionActivities>({
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '5 minutes',
  retry: { maximumAttempts: 2 },
});

export async function codeSession(input: { workspaceId: string; sessionId: string }): Promise<void> {
  const { workspaceId, sessionId } = input;
  let stopped = false;
  let activeStageScope: CancellationScope | null = null;
  const answersByRequestId = new Map<string, CodeSessionRequestAnswer>();

  setHandler(codeSessionSignal, signal => {
    if (signal.kind === 'stop') {
      stopped = true;
      activeStageScope?.cancel();
      return;
    }
    answersByRequestId.set(signal.requestId, signal.answer);
  });

  async function runStageCancellable(
    stage: 'brainstorm' | 'plan' | 'code' | 'verify',
    context: { answers: string[]; guidance?: string | undefined },
  ): Promise<{ outcome: CodeSessionStageOutcome; activeMs: number } | null> {
    if (stopped) return null;
    const scope = new CancellationScope();
    activeStageScope = scope;
    try {
      return await scope.run(() => acts.runCodeSessionStage(workspaceId, sessionId, stage, context));
    } catch (error) {
      if (stopped && isCancellation(error)) return null;
      throw error;
    } finally {
      if (activeStageScope === scope) activeStageScope = null;
    }
  }

  async function waitForAnswer(request: CodeSessionRequestView): Promise<CodeSessionRequestAnswer | null> {
    while (!stopped) {
      const signaled = await condition(() => stopped || answersByRequestId.has(request.id), '30 seconds');
      if (stopped) return null;
      if (signaled && answersByRequestId.has(request.id)) {
        return answersByRequestId.get(request.id) ?? null;
      }
      const state = await acts.readCodeSessionRequestState(workspaceId, sessionId, request.id);
      if (state.stage === 'stopped' || state.stage === 'merged' || state.stage === 'failed') {
        stopped = true;
        return null;
      }
      if (state.request?.answer) {
        return state.request.answer;
      }
    }
    return null;
  }

  async function checkBudget(session: CodeSessionView): Promise<boolean> {
    if (session.activeMs < session.budgetMs) return true;
    const req = await acts.openCodeSessionInboxRequest(workspaceId, sessionId, {
      kind: 'budget',
      activeMinutes: Math.round(session.activeMs / 60_000),
      budgetMinutes: Math.round(session.budgetMs / 60_000),
    });
    const ans = await waitForAnswer(req);
    if (!ans || ans.kind !== 'budget' || ans.decision === 'stop') {
      await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped' });
      return false;
    }
    await acts.advanceCodeSession(workspaceId, sessionId, {
      stage: session.stage,
      addBudgetMs: (ans.addMinutes ?? 120) * 60_000,
    });
    return true;
  }

  async function handleUsageLimit(resetAt: string | undefined): Promise<boolean> {
    const parsedResetAt = resetAt ? Date.parse(resetAt) : Number.NaN;
    const targetMs = Number.isFinite(parsedResetAt) ? Math.max(60_000, parsedResetAt - Date.now()) : 15 * 60_000;
    const cappedMs = Math.min(targetMs, 12 * 60 * 60_000);
    const wakeAt = new Date(Date.now() + cappedMs).toISOString();
    const current = await acts.loadCodeSession(workspaceId, sessionId);
    await acts.advanceCodeSession(workspaceId, sessionId, {
      stage: current.stage,
      usageLimitUntil: wakeAt,
    });
    await Promise.race([sleep(cappedMs), condition(() => stopped)]);
    if (stopped) {
      await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped', usageLimitUntil: null });
      return false;
    }
    await acts.advanceCodeSession(workspaceId, sessionId, { stage: current.stage, usageLimitUntil: null });
    return true;
  }

  const qaHistory: string[] = [];
  let guidance: string | undefined;

  function extractErrorMessage(error: unknown): string {
    const messages: string[] = [];
    let current: unknown = error;
    let depth = 0;
    while (current && depth < 6) {
      if (typeof current === 'object' && 'message' in current && typeof current.message === 'string') {
        const cleaned = current.message.replace(/\s+/g, ' ').trim();
        if (cleaned) messages.push(cleaned);
      }
      current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
      depth += 1;
    }
    const meaningful = [...messages]
      .reverse()
      .find(msg => msg !== 'Activity task failed' && msg !== 'Workflow task failed');
    return (meaningful ?? messages[0] ?? 'Code session failed unexpectedly.').slice(0, 400);
  }

  async function recordFailure(error: unknown): Promise<void> {
    if (stopped) {
      await CancellationScope.nonCancellable(() =>
        acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped' }),
      );
      return;
    }
    const sanitized = extractErrorMessage(error);
    await CancellationScope.nonCancellable(async () => {
      try {
        const current = await acts.loadCodeSession(workspaceId, sessionId);
        if (current.stage === 'stopped' || current.stage === 'merged' || current.stage === 'failed') return;
        await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'failed', errorMessage: sanitized });
      } catch {
        // Best-effort failure persistence.
      }
    });
  }

  try {
    // Phase 1: Brainstorm & Plan
    let planApproved = false;
    while (!planApproved && !stopped) {
      let session = await acts.loadCodeSession(workspaceId, sessionId);
      if (session.stage === 'stopped' || session.stage === 'merged' || session.stage === 'failed') return;
      if (!(await checkBudget(session))) return;

      const stageToRun: 'brainstorm' | 'plan' = session.stage === 'plan' ? 'plan' : 'brainstorm';
      const stageRun = await runStageCancellable(stageToRun, {
        answers: qaHistory,
        guidance,
      });
      if (!stageRun || stopped) {
        await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped' });
        return;
      }
      const { outcome, activeMs } = stageRun;
      guidance = undefined;

      if (outcome.kind === 'limit') {
        await acts.advanceCodeSession(workspaceId, sessionId, { stage: session.stage, addActiveMs: activeMs });
        if (!(await handleUsageLimit(outcome.resetAt))) return;
        continue;
      }

      if (outcome.kind === 'questions') {
        await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'brainstorm', addActiveMs: activeMs });
        for (let i = 0; i < outcome.questions.length; i += 1) {
          const q = outcome.questions[i]!;
          const req = await acts.openCodeSessionInboxRequest(workspaceId, sessionId, {
            kind: 'question',
            question: q.question,
            questionIndex: i + 1,
            totalQuestions: outcome.questions.length,
            options: q.options,
            allowFreeText: true,
          });
          const ans = await waitForAnswer(req);
          if (!ans || ans.kind !== 'question') {
            await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped' });
            return;
          }
          qaHistory.push(`Q: ${q.question}\nA: ${ans.text}`);
        }
        await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'plan' });
        continue;
      }

      if (outcome.kind === 'plan' || outcome.kind === 'done') {
        const planTitle = outcome.kind === 'plan' ? outcome.title : session.title;
        const planSummary = outcome.summary;
        const planMarkdown = outcome.kind === 'plan' ? outcome.markdown : outcome.summary;
        session = await acts.advanceCodeSession(workspaceId, sessionId, {
          stage: 'plan',
          addActiveMs: activeMs,
          summary: planSummary,
          planMarkdown,
        });
        session = await acts.advanceCodeSession(workspaceId, sessionId, {
          stage: 'awaiting-plan-approval',
        });
        const req = await acts.openCodeSessionInboxRequest(workspaceId, sessionId, {
          kind: 'plan-approval',
          planTitle,
          planSummary,
          planMarkdown,
          repository: session.repository,
          baseBranch: session.baseBranch,
          sessionBranch: session.sessionBranch,
          agent: session.agent,
          reviewers: session.reviewers,
          budgetMinutes: Math.round(session.budgetMs / 60_000),
          planOwnerLabel: session.githubAccount ?? 'Your connected plan',
        });
        const ans = await waitForAnswer(req);
        if (!ans || ans.kind !== 'plan-approval' || ans.decision === 'stop') {
          await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped' });
          return;
        }
        if (ans.decision === 'revise') {
          guidance = ans.feedback || 'Please revise the plan.';
          await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'plan' });
          continue;
        }
        await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'code', planApproved: true });
        planApproved = true;
        break;
      }

      // Blocked during brainstorm/plan
      await acts.advanceCodeSession(workspaceId, sessionId, { stage: session.stage, addActiveMs: activeMs });
      const stuckReq = await acts.openCodeSessionInboxRequest(workspaceId, sessionId, {
        kind: 'stuck',
        reason: 'agent-blocked',
        summary: outcome.reason,
      });
      const stuckAns = await waitForAnswer(stuckReq);
      if (!stuckAns || stuckAns.kind !== 'stuck' || stuckAns.decision === 'stop') {
        await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped', errorMessage: outcome.reason });
        return;
      }
      guidance = stuckAns.guidance;
      if (stuckAns.decision === 'switch-agent' && stuckAns.agent) {
        await acts.advanceCodeSession(workspaceId, sessionId, { stage: session.stage, agent: stuckAns.agent });
      }
    }

    // Phase 2: Code -> Verify -> PR -> Review -> Merge
    let fixAttempts = 0;
    let reviewRounds = 0;
    let lastDiffSummary = '';
    let lastChecks: Array<{
      name: string;
      status: 'passed' | 'failed' | 'pending' | 'skipped';
      details?: string | undefined;
      url?: string | undefined;
    }> = [];
    let lastScreenshots: string[] = [];
    let lastReviews: CodeSessionReviewVerdict[] = [];

    while (!stopped) {
      let session = await acts.loadCodeSession(workspaceId, sessionId);
      if (session.stage === 'stopped' || session.stage === 'merged' || session.stage === 'failed') return;
      if (!(await checkBudget(session))) return;

      if (session.stage === 'code') {
        const stageRun = await runStageCancellable('code', {
          answers: qaHistory,
          guidance,
        });
        if (!stageRun || stopped) {
          await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped' });
          return;
        }
        const { outcome, activeMs } = stageRun;
        guidance = undefined;
        if (outcome.kind === 'limit') {
          await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'code', addActiveMs: activeMs });
          if (!(await handleUsageLimit(outcome.resetAt))) return;
          continue;
        }
        if (outcome.kind === 'blocked') {
          await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'code', addActiveMs: activeMs });
          const req = await acts.openCodeSessionInboxRequest(workspaceId, sessionId, {
            kind: 'stuck',
            reason: 'agent-blocked',
            summary: outcome.reason,
          });
          const ans = await waitForAnswer(req);
          if (!ans || ans.kind !== 'stuck' || ans.decision === 'stop') {
            await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped', errorMessage: outcome.reason });
            return;
          }
          guidance = ans.guidance;
          if (ans.decision === 'switch-agent' && ans.agent) {
            await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'code', agent: ans.agent });
          }
          continue;
        }
        if (outcome.kind === 'done') {
          lastDiffSummary = outcome.diffSummary ?? outcome.summary;
        }
        await acts.advanceCodeSession(workspaceId, sessionId, {
          stage: 'verify',
          addActiveMs: activeMs,
          summary: outcome.kind === 'done' ? outcome.summary : session.summary,
        });
        continue;
      }

      if (session.stage === 'verify') {
        const stageRun = await runStageCancellable('verify', {
          answers: qaHistory,
        });
        if (!stageRun || stopped) {
          await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped' });
          return;
        }
        const { outcome, activeMs } = stageRun;
        if (outcome.kind === 'limit') {
          await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'verify', addActiveMs: activeMs });
          if (!(await handleUsageLimit(outcome.resetAt))) return;
          continue;
        }
        const failed = outcome.kind !== 'done' || outcome.checks.some(check => check.status === 'failed');
        if (outcome.kind === 'done') {
          lastChecks = outcome.checks;
          lastScreenshots = outcome.screenshots;
          if (outcome.diffSummary) lastDiffSummary = outcome.diffSummary;
        }
        if (failed) {
          fixAttempts += 1;
          if (fixAttempts >= MAX_FIX_ATTEMPTS) {
            const reasonSummary =
              outcome.kind === 'blocked' ? outcome.reason : `Verification failed after ${fixAttempts} attempts.`;
            await acts.advanceCodeSession(workspaceId, sessionId, {
              stage: 'verify',
              addActiveMs: activeMs,
              fixAttempts,
            });
            const req = await acts.openCodeSessionInboxRequest(workspaceId, sessionId, {
              kind: 'stuck',
              reason: 'verify-failed',
              summary: reasonSummary,
            });
            const ans = await waitForAnswer(req);
            if (!ans || ans.kind !== 'stuck' || ans.decision === 'stop') {
              await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped', errorMessage: reasonSummary });
              return;
            }
            fixAttempts = 0;
            guidance = ans.guidance;
            await acts.advanceCodeSession(workspaceId, sessionId, {
              stage: 'code',
              fixAttempts: 0,
              agent: ans.decision === 'switch-agent' ? ans.agent : undefined,
            });
            continue;
          }
          guidance = outcome.kind === 'blocked' ? outcome.reason : 'Fix the failing verification checks.';
          await acts.advanceCodeSession(workspaceId, sessionId, {
            stage: 'code',
            addActiveMs: activeMs,
            fixAttempts,
          });
          continue;
        }
        await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'pull-request', addActiveMs: activeMs });
        continue;
      }

      if (session.stage === 'pull-request') {
        let draft = session.openAsDraft;
        if (!session.pullRequestNumber) {
          if (!session.openPullRequests) {
            const req = await acts.openCodeSessionInboxRequest(workspaceId, sessionId, {
              kind: 'pr-approval',
              repository: session.repository,
              baseBranch: session.baseBranch,
              sessionBranch: session.sessionBranch,
              draft,
              summary: lastDiffSummary || session.summary || session.title,
            });
            const ans = await waitForAnswer(req);
            if (!ans || ans.kind !== 'pr-approval' || ans.decision !== 'open-pr') {
              await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped' });
              return;
            }
            if (ans.draft !== undefined) draft = ans.draft;
          }
          const pr = await acts.openCodeSessionPullRequest(workspaceId, sessionId, draft);
          if (pr.status === 'blocked') {
            const req = await acts.openCodeSessionInboxRequest(workspaceId, sessionId, {
              kind: 'stuck',
              reason: 'agent-blocked',
              summary: pr.reason,
            });
            const ans = await waitForAnswer(req);
            if (!ans || ans.kind !== 'stuck' || ans.decision === 'stop') {
              await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped', errorMessage: pr.reason });
              return;
            }
            guidance = ans.guidance;
            continue;
          }
          session = await acts.advanceCodeSession(workspaceId, sessionId, {
            stage: 'review',
            pullRequestNumber: pr.number,
            pullRequestUrl: pr.url,
          });
        } else {
          await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'review' });
        }
        continue;
      }

      if (session.stage === 'review') {
        const reviewResult = await acts.runCodeSessionReviews(workspaceId, sessionId);
        lastReviews = reviewResult.verdicts;
        if (!reviewResult.approved) {
          reviewRounds += 1;
          if (reviewRounds >= MAX_REVIEW_ROUNDS) {
            const req = await acts.openCodeSessionInboxRequest(workspaceId, sessionId, {
              kind: 'stuck',
              reason: 'review-rounds',
              summary: `Review requested changes for ${reviewRounds} rounds.`,
            });
            const ans = await waitForAnswer(req);
            if (!ans || ans.kind !== 'stuck' || ans.decision === 'stop') {
              await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped' });
              return;
            }
            reviewRounds = 0;
            guidance = ans.guidance;
            await acts.advanceCodeSession(workspaceId, sessionId, {
              stage: 'code',
              reviewRounds: 0,
              agent: ans.decision === 'switch-agent' ? ans.agent : undefined,
            });
            continue;
          }
          guidance = reviewResult.verdicts.map(v => `${v.reviewerAgent}: ${v.summary}`).join('\n');
          await acts.advanceCodeSession(workspaceId, sessionId, {
            stage: 'code',
            addActiveMs: reviewResult.activeMs,
            reviewRounds,
          });
          continue;
        }
        await acts.advanceCodeSession(workspaceId, sessionId, {
          stage: 'awaiting-merge-approval',
          addActiveMs: reviewResult.activeMs,
        });
        continue;
      }

      if (session.stage === 'awaiting-merge-approval') {
        const req = await acts.openCodeSessionInboxRequest(workspaceId, sessionId, {
          kind: 'merge-approval',
          pullRequestNumber: session.pullRequestNumber ?? 0,
          pullRequestUrl: session.pullRequestUrl ?? `https://github.com/${session.repository}`,
          diffSummary: lastDiffSummary || session.summary || session.title,
          checks: lastChecks,
          screenshots: lastScreenshots,
          reviews: lastReviews,
        });
        const ans = await waitForAnswer(req);
        if (!ans || ans.kind !== 'merge-approval' || ans.decision === 'stop') {
          await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped' });
          return;
        }
        if (ans.decision === 'request-changes') {
          guidance = ans.feedback || 'Address the requested changes.';
          await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'code' });
          continue;
        }
        await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'merging' });
        continue;
      }

      if (session.stage === 'merging') {
        const merged = await acts.mergeCodeSessionPullRequest(workspaceId, sessionId);
        if (merged.status === 'blocked') {
          const req = await acts.openCodeSessionInboxRequest(workspaceId, sessionId, {
            kind: 'stuck',
            reason: 'agent-blocked',
            summary: merged.message,
          });
          const ans = await waitForAnswer(req);
          if (!ans || ans.kind !== 'stuck' || ans.decision === 'stop') {
            await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'stopped', errorMessage: merged.message });
            return;
          }
          guidance = ans.guidance;
          continue;
        }
        if (merged.status === 'conflict') {
          guidance = `Merge conflict on ${session.baseBranch}: ${merged.message}. Rebase ${session.sessionBranch} onto ${session.baseBranch} and re-verify.`;
          await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'code' });
          continue;
        }
        await acts.advanceCodeSession(workspaceId, sessionId, { stage: 'merged', summary: merged.message });
        return;
      }

      return;
    }
  } catch (error) {
    await recordFailure(error);
    if (!stopped) throw error;
  }
}
