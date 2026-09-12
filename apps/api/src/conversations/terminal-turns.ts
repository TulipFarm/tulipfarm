import { randomUUID } from "node:crypto";
import { textContent } from "@tulipfarm/schema";
import type { PersistedRun, PersistedRunEvent } from "@tulipfarm/storage";
import {
  foldParticipantEvent,
  type HostedTurnHistory,
  historyFromMessage,
} from "../internal/turn-host";
import type { PersistedTurn, TerminalTurnStore } from "./service";

type TerminalRunStatus = Extract<PersistedRun["status"], "succeeded" | "failed" | "cancelled">;

function isTerminal(status: PersistedRun["status"]): status is TerminalRunStatus {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export interface TerminalTurnSettlerOptions {
  readonly turns: TerminalTurnStore;
  readonly runs: {
    find(businessId: string, runId: string): Promise<PersistedRun | null>;
  };
  readonly events: {
    latestSequence(businessId: string, runId: string): Promise<number>;
    list(
      businessId: string,
      runId: string,
      options: { after: number; audiences: readonly ["participant"]; limit: number }
    ): Promise<readonly PersistedRunEvent[]>;
  };
  now?(): Date;
}

/** Settles Conversation Turns from the durable Run outcome, fenced to the current Run and attempt. */
export class TerminalTurnSettler {
  private readonly now: () => Date;

  constructor(private readonly options: TerminalTurnSettlerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async reconcileRun(businessId: string, runId: string): Promise<boolean> {
    const run = await this.options.runs.find(businessId, runId);
    if (run === null || !isTerminal(run.status)) return false;
    const turn = await this.options.turns.findTurnByRunId(businessId, runId);
    if (turn === undefined) return false;

    const status = run.status === "succeeded" ? "succeeded" : "failed";
    const cursor = await this.options.events.latestSequence(businessId, runId);
    await this.checkpointHistory(turn, runId, run.status, cursor);
    const result = await this.options.turns.settleTerminalTurn({
      businessId,
      turnId: turn.id,
      runId,
      attempt: turn.attempt,
      status,
      cursor,
      ...(run.status === "failed"
        ? { reason: "run_failed" }
        : run.status === "cancelled"
          ? { reason: "run_cancelled" }
          : {}),
      createdAt: this.now(),
      historyOutcome: run.status,
    });
    return result.status !== "stale";
  }

  private async checkpointHistory(
    turn: PersistedTurn,
    runId: string,
    outcome: TerminalRunStatus,
    cursor: number
  ): Promise<void> {
    const message = await this.options.turns.findAttemptMessage?.(
      turn.businessId,
      turn.id,
      turn.attempt
    );
    let history = historyFromMessage(message?.content, message?.metadata, runId, turn.attempt);
    while (history.cursor < cursor) {
      const events = await this.options.events.list(turn.businessId, runId, {
        after: history.cursor,
        audiences: ["participant"],
        limit: 500,
      });
      if (events.length === 0) break;
      for (const event of events) history = foldParticipantEvent(history, event);
    }
    const settled: HostedTurnHistory = {
      text: history.text,
      toolCalls: history.toolCalls,
      surfaces: history.surfaces,
      cursor,
      outcome,
      complete: true,
    };
    if (
      settled.text.length === 0 &&
      settled.toolCalls.length === 0 &&
      settled.surfaces.length === 0
    ) {
      return;
    }
    await this.options.turns.appendAssistantMessage({
      message: {
        id: message?.id ?? randomUUID(),
        businessId: turn.businessId,
        conversationId: turn.conversationId,
        turnId: turn.id,
        role: "assistant",
        content: textContent(settled.text),
        metadata: {
          ...(settled.toolCalls.length === 0 ? {} : { toolCalls: settled.toolCalls }),
          ...(settled.surfaces.length === 0 ? {} : { surfaces: settled.surfaces }),
          turnAttempt: {
            runId,
            attempt: turn.attempt,
            cursor,
            outcome,
            complete: true,
          },
        },
        attempt: turn.attempt,
        createdAt: message?.createdAt ?? this.now(),
      },
      runId,
      attempt: turn.attempt,
    });
  }

  async reconcileConversation(businessId: string, conversationId: string): Promise<void> {
    const latest = await this.options.turns.findLatestTurn(businessId, conversationId);
    if (
      latest === undefined ||
      latest.runId === null ||
      (latest.status !== "pending" && latest.status !== "running")
    ) {
      return;
    }
    await this.reconcileRun(businessId, latest.runId);
  }
}
