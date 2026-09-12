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

/** The durable Run claim allowed to replace this checkpoint. */
export interface LoopCheckpointFence {
  readonly leaseGeneration: number;
}

export interface LoopCheckpointStore {
  load(
    businessId: string,
    runId: string,
    stateId: string
  ): Promise<AgentLoopCheckpoint | undefined>;
  save(checkpoint: AgentLoopCheckpoint, fence?: LoopCheckpointFence): Promise<void>;
  clear(
    businessId: string,
    runId: string,
    stateId?: string,
    fence?: LoopCheckpointFence
  ): Promise<void>;
  acknowledgeTerminal(
    businessId: string,
    runId: string,
    stateId: string,
    fence?: LoopCheckpointFence
  ): Promise<void>;
  settle(
    businessId: string,
    runId: string,
    stateId?: string,
    fence?: LoopCheckpointFence
  ): Promise<void>;
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

  async save(checkpoint: AgentLoopCheckpoint, _fence?: LoopCheckpointFence): Promise<void> {
    this.checkpoints.set(
      `${checkpoint.businessId}/${checkpoint.runId}/${checkpoint.stateId}`,
      checkpoint
    );
  }

  async clear(businessId: string, runId: string, stateId?: string): Promise<void> {
    if (stateId !== undefined) {
      this.checkpoints.delete(`${businessId}/${runId}/${stateId}`);
      return;
    }
    const prefix = `${businessId}/${runId}/`;
    for (const key of this.checkpoints.keys()) {
      if (key.startsWith(prefix)) this.checkpoints.delete(key);
    }
  }

  async acknowledgeTerminal(businessId: string, runId: string, stateId: string): Promise<void> {
    const key = `${businessId}/${runId}/${stateId}`;
    const checkpoint = this.checkpoints.get(key);
    if (checkpoint?.resume?.terminal === undefined) return;
    const { terminal: _acknowledged, ...resume } = checkpoint.resume;
    this.checkpoints.set(key, {
      ...checkpoint,
      resume: { ...resume, retryAttempt: (resume.retryAttempt ?? 0) + 1 },
    });
  }

  async settle(businessId: string, runId: string, stateId?: string): Promise<void> {
    const prefix = `${businessId}/${runId}/`;
    for (const [key, checkpoint] of this.checkpoints) {
      if (!key.startsWith(prefix) || (stateId !== undefined && checkpoint.stateId !== stateId)) {
        continue;
      }
      if (
        checkpoint.resume?.retryable === true ||
        checkpoint.resume?.terminal?.retryable === true
      ) {
        const { terminal: _delivered, ...resume } = checkpoint.resume;
        this.checkpoints.set(key, { ...checkpoint, resume });
      } else {
        this.checkpoints.delete(key);
      }
    }
  }
}
