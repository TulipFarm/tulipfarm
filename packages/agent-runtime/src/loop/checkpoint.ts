import type { AgentLoopResumeState } from "./resume";

/** Durable counters make loop, Tool-call, and repair limits survive resume. */
export interface AgentLoopCheckpoint {
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly repairs: number;
  /**
   * The unfinished loop's transcript, and the work a failed-but-retryable Turn already paid for.
   *
   * Absent once the loop settles for a reason a retry cannot fix, so Tool arguments and outputs
   * live no longer than the Turn that could still use them.
   */
  readonly resume?: AgentLoopResumeState;
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
