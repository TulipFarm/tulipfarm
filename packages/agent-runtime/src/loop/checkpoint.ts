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
   * Present only while the loop is unfinished. A terminal outcome saves it absent, so Tool
   * arguments and outputs live no longer than the Turn that is still owed an answer.
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
