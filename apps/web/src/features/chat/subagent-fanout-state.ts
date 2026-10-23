import type { AgentFanoutAgent, AgentFanoutStatus } from '@tulipfarm/sprout/agent-fanout';
import type { SubagentResult, SubagentStatus } from '@tulipfarm/conversations/events';
import type { LiveSubagents } from './conversation-stream';

export type DelegationTool = { id: string; tool: string; status: string; subagents?: SubagentResult | undefined };
export type SubagentEntry = {
  key: string;
  name: string;
  role: string;
  status: SubagentStatus;
  step?: string | undefined;
  credits: number;
  elapsedMs: number;
  report?: string | undefined;
};
export type DelegationView = { entries: SubagentEntry[]; totalCredits: number; live: boolean; receivedAt?: number };

/**
 * The sub-agents of one `agents.delegate` call. The saved result wins over live cards once the call has one;
 * before the first live update there is nothing to show beyond the tool activity row.
 */
export function delegationView(tool: DelegationTool, live?: LiveSubagents): DelegationView | null {
  if (tool.tool !== 'agents.delegate') return null;
  if (tool.subagents) return { entries: tool.subagents.agents, totalCredits: tool.subagents.totalCredits, live: false };
  if (!live || tool.status !== 'running') return null;
  return {
    entries: live.agents,
    totalCredits: live.agents.reduce((sum, agent) => sum + agent.credits, 0),
    live: true,
    receivedAt: live.receivedAt,
  };
}

/** AgentFanout has no timed-out state, so a timed-out sub-agent shows as stopped with the reason "Timed out". */
const fanoutStatus: Record<SubagentStatus, AgentFanoutStatus> = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
  'timed-out': 'stopped',
  stopped: 'stopped',
};
export const subagentStatusLabel: Record<SubagentStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  'timed-out': 'Timed out',
  stopped: 'Stopped',
};
const active = new Set<SubagentStatus>(['queued', 'running']);

export function isActiveSubagent(entry: SubagentEntry) {
  return active.has(entry.status);
}

/** The chat as the root agent, with one child per sub-agent. Running agents' times advance from `now`. */
export function fanoutRoot(view: DelegationView, now: number): AgentFanoutAgent {
  const advance = view.live && view.receivedAt !== undefined ? Math.max(0, now - view.receivedAt) : 0;
  const agents = view.entries.map((entry): AgentFanoutAgent => ({
    id: entry.key,
    name: entry.name,
    task: entry.step ? `${entry.role}: ${entry.step}` : entry.role,
    status: fanoutStatus[entry.status],
    elapsed: entry.elapsedMs + (entry.status === 'running' ? advance : 0),
    reason:
      entry.status === 'timed-out' || entry.status === 'failed' || entry.status === 'stopped'
        ? subagentStatusLabel[entry.status]
        : undefined,
  }));
  const running = view.entries.some(isActiveSubagent);
  return {
    id: 'chat',
    name: 'Chat',
    task: `${running ? 'Running' : 'Ran'} ${agents.length} sub-agent${agents.length === 1 ? '' : 's'}`,
    status: running ? 'running' : 'done',
    agents,
  };
}

const creditFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
export function formatCredits(credits: number) {
  return `${creditFormat.format(credits)} credit${credits === 1 ? '' : 's'}`;
}
