/**
 * Durable loop counters (SPEC §10). Limits are only real if they survive a crash: a resumed Agent
 * State continues from the persisted counters instead of restarting its iteration, Tool-call, and
 * repair budgets from zero.
 */
export interface AgentLoopCheckpoint {
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly repairs: number;
}

export interface LoopCheckpointStore {
  load(runId: string, stateId: string): Promise<AgentLoopCheckpoint | undefined>;
  save(checkpoint: AgentLoopCheckpoint): Promise<void>;
}

export class InMemoryLoopCheckpointStore implements LoopCheckpointStore {
  private readonly checkpoints = new Map<string, AgentLoopCheckpoint>();

  async load(runId: string, stateId: string): Promise<AgentLoopCheckpoint | undefined> {
    return this.checkpoints.get(`${runId}/${stateId}`);
  }

  async save(checkpoint: AgentLoopCheckpoint): Promise<void> {
    this.checkpoints.set(`${checkpoint.runId}/${checkpoint.stateId}`, checkpoint);
  }
}
