import { useMemo } from 'react';
import { z } from 'zod';
import {
  workspaceEvalCaseSchema,
  workspaceEvalEstimateSchema,
  workspaceEvalRunDetailSchema,
  workspaceEvalRunSchema,
  workspaceEvalSetSchema,
  type EvalCaseInput,
  type RunRequest,
} from '@tulipfarm/evals/contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { useFeatureRead } from '@/lib/query';
import { TableRequestError } from '@/features/tables/request-state';

export type EvalSet = z.infer<typeof workspaceEvalSetSchema>;
export type EvalCaseView = z.infer<typeof workspaceEvalCaseSchema>;
export type EvalRun = z.infer<typeof workspaceEvalRunSchema>;
export type EvalRunDetail = z.infer<typeof workspaceEvalRunDetailSchema>;
export type EvalEstimate = z.infer<typeof workspaceEvalEstimateSchema>;

const messages: Partial<Record<string, string>> = {
  'case-limit': 'This agent already has the most eval cases it can keep. Delete one before adding another.',
  'run-active': 'An eval run is already in progress for this agent. Wait for it to finish, or stop it.',
  'run-finished': 'This run has already finished.',
  'reply-limit': 'This run would need more than 300 agent replies. Choose fewer cases, repeats or models.',
  'no-cases': 'Add an eval case before running.',
  'model-unavailable': 'A chosen model is not available in this workspace. Choose another model.',
  'credits-exhausted':
    'Your workspace has no available credits. Ask a workspace admin to check credits. Your input is retained.',
  'invalid-request': 'Some details are not valid. Check the case and try again. Your input is retained.',
};

export function evalsApi(workspaceId: string, agentId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/evals`;
  async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      cache: 'no-store',
      signal: signal ?? AbortSignal.timeout(15000),
      body,
    });
    const value = await readJson(response);
    if (!response.ok) {
      const code = responseError(value, 'agent-operation-failed');
      throw new TableRequestError(
        response.status,
        code,
        messages[code] ??
          (response.status === 404
            ? 'This agent is missing or you no longer have access.'
            : 'Evals could not be updated. Your input is retained. Try again.'),
      );
    }
    return value;
  }
  return {
    read: async (signal: AbortSignal) => workspaceEvalSetSchema.parse(await request('', 'GET', undefined, signal)),
    createCase: async (input: EvalCaseInput) => workspaceEvalCaseSchema.parse(await request('/cases', 'POST', input)),
    updateCase: async (caseId: string, input: EvalCaseInput) =>
      workspaceEvalCaseSchema.parse(await request(`/cases/${encodeURIComponent(caseId)}`, 'PUT', input)),
    deleteCase: async (caseId: string) => {
      await request(`/cases/${encodeURIComponent(caseId)}`, 'DELETE');
    },
    setJudge: async (judgeModel: string | null) => {
      await request('/judge', 'PUT', { judgeModel });
    },
    estimate: async (input: RunRequest) => workspaceEvalEstimateSchema.parse(await request('/estimate', 'POST', input)),
    start: async (input: RunRequest) => workspaceEvalRunSchema.parse(await request('/runs', 'POST', input)),
    runs: async (signal: AbortSignal) =>
      z.array(workspaceEvalRunSchema).parse(await request('/runs', 'GET', undefined, signal)),
    run: async (runId: string, signal: AbortSignal) =>
      workspaceEvalRunDetailSchema.parse(await request(`/runs/${encodeURIComponent(runId)}`, 'GET', undefined, signal)),
    cancel: async (runId: string) =>
      workspaceEvalRunSchema.parse(await request(`/runs/${encodeURIComponent(runId)}/cancel`, 'POST')),
  };
}
export type EvalsApi = ReturnType<typeof evalsApi>;

export const evalKeys = {
  set: (agentId: string) => ['agents', 'detail', agentId, 'evals'] as const,
  runs: (agentId: string) => ['agents', 'detail', agentId, 'evals', 'runs'] as const,
  run: (agentId: string, runId: string) => ['agents', 'detail', agentId, 'evals', 'runs', runId] as const,
};

const active = (status: EvalRun['status']) => status === 'queued' || status === 'running';

export function useEvalsApi(workspaceId: string, agentId: string) {
  return useMemo(() => evalsApi(workspaceId, agentId), [workspaceId, agentId]);
}
export function useEvalSet(api: EvalsApi, agentId: string, enabled: boolean) {
  return useFeatureRead({ key: evalKeys.set(agentId), load: api.read, enabled });
}
export function useEvalRuns(api: EvalsApi, agentId: string, enabled: boolean) {
  return useFeatureRead({
    key: evalKeys.runs(agentId),
    load: api.runs,
    enabled,
    pollWhile: runs => runs.some(run => active(run.status)),
    interval: 3000,
    maxChecks: 5000,
    maxDuration: 4 * 60 * 60_000,
  });
}
export function useEvalRun(api: EvalsApi, agentId: string, runId: string | null) {
  return useFeatureRead({
    key: evalKeys.run(agentId, runId ?? 'none'),
    load: (signal: AbortSignal) => api.run(runId!, signal),
    enabled: runId !== null,
    pollWhile: run => active(run.status),
    interval: 3000,
    maxChecks: 5000,
    maxDuration: 4 * 60 * 60_000,
  });
}
