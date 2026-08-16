/** Durable counters make loop, Tool-call, and repair limits survive resume. */
export interface AgentLoopCheckpoint {
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly repairs: number;
}

export interface LoopCheckpointStore {
  load(
    businessId: string,
    runId: string,
    stateId: string
  ): Promise<AgentLoopCheckpoint | undefined>;
  save(checkpoint: AgentLoopCheckpoint): Promise<void>;
}

export class InMemoryLoopCheckpointStore implements LoopCheckpointStore {
  private readonly checkpoints = new Map<string, AgentLoopCheckpoint>();

  async load(
    businessId: string,
    runId: string,
    stateId: string
  ): Promise<AgentLoopCheckpoint | undefined> {
    return this.checkpoints.get(`${businessId}/${runId}/${stateId}`);
  }

  async save(checkpoint: AgentLoopCheckpoint): Promise<void> {
    this.checkpoints.set(
      `${checkpoint.businessId}/${checkpoint.runId}/${checkpoint.stateId}`,
      checkpoint
    );
  }
}
