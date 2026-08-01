import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type {
  ConversationStore,
  PersistedMessage,
  PersistedTurn,
  TurnCompletion,
} from "../conversations/service";
import type { HostedRunReader } from "../internal/turn-host";

/** Shared doubles for the internal turn host's tests. */

export const BUSINESS_ID = DEPLOYMENT_BUSINESS_ID;
export const CONVERSATION_ID = "conversation-1";
export const TURN_ID = "turn-1";
export const RUN_ID = "run-1";
export const CREATED_AT = new Date("2026-07-27T00:00:00.000Z");

export function turn(overrides: Partial<PersistedTurn> = {}): PersistedTurn {
  return {
    id: TURN_ID,
    businessId: BUSINESS_ID,
    conversationId: CONVERSATION_ID,
    idempotencyKey: "key-1",
    requestMessageId: "message-1",
    status: "running",
    attempt: 1,
    runId: RUN_ID,
    cursor: 0,
    supersededRunIds: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

export class FakeConversationStore implements ConversationStore {
  readonly messages: PersistedMessage[] = [];
  readonly turns: PersistedTurn[] = [];
  readonly completions: TurnCompletion[] = [];

  async findTurnByIdempotencyKey(_businessId: string, key: string) {
    return this.turns.find((candidate) => candidate.idempotencyKey === key);
  }

  async findTurn(_businessId: string, turnId: string) {
    return this.turns.find((candidate) => candidate.id === turnId);
  }

  async findTurnByRunId(_businessId: string, runId: string) {
    return this.turns.find((candidate) => candidate.runId === runId);
  }

  async appendMessage(message: PersistedMessage) {
    this.messages.push(message);
  }

  async saveTurn(saved: PersistedTurn) {
    const index = this.turns.findIndex((candidate) => candidate.id === saved.id);
    if (index === -1) this.turns.push(saved);
    else this.turns[index] = saved;
  }

  async listMessages(_businessId: string, conversationId: string) {
    return this.messages.filter((message) => message.conversationId === conversationId);
  }

  async findCompletion(_businessId: string, turnId: string, attempt: number) {
    return this.completions.find(
      (completion) => completion.turnId === turnId && completion.attempt === attempt
    );
  }

  async saveCompletion(completion: TurnCompletion) {
    const recorded = await this.findCompletion(
      completion.businessId,
      completion.turnId,
      completion.attempt
    );
    if (recorded === undefined) this.completions.push(completion);
  }
}

/** A Run reader holding one Run, so a test states only what it is varying. */
export function fakeRuns(
  run: {
    status?: string;
    digest?: string;
    /** What minted the Run — the `bundle.routineId` a host reads its source from. */
    source?: string;
    subject?: { kind: string; id: string };
  } | null = {}
): HostedRunReader {
  return {
    async find() {
      if (run === null) return null;
      return {
        status: run.status ?? "running",
        bundle: { digest: run.digest ?? "bundle-digest", routineId: run.source ?? "chat" },
        identity: { effectiveSubject: run.subject ?? { kind: "user", id: "user-1" } },
      };
    },
  };
}
