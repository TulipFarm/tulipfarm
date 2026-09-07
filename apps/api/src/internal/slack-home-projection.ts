import type { ConversationTurn } from "@tulipfarm/schema";
import type { SoulAgent } from "@tulipfarm/soul";
import type { TaskRecord } from "@tulipfarm/storage";
import type { PendingToolApproval } from "@tulipfarm/tool-host";
import type { ConversationDoc } from "../chat/conversations";
import type { SlackHomeProjection } from "./slack-home-routes";

const SECTION_LIMIT = 5;
const CONVERSATION_CANDIDATE_LIMIT = 10;

interface RoutineApproval {
  readonly payload: unknown;
}

export interface SlackHomeProjectionDeps {
  readonly webOrigin: string;
  readonly toolApprovals?: {
    listPendingFor(input: {
      businessId: string;
      principal: string;
    }): Promise<readonly PendingToolApproval[]>;
  };
  readonly routineApprovals?: {
    listPendingFor(input: {
      businessId: string;
      roles: readonly string[];
    }): Promise<readonly RoutineApproval[]>;
  };
  readonly tasks?: {
    listForPrincipal(
      businessId: string,
      userId: string,
      roles: readonly string[],
      includeSnoozed: boolean
    ): Promise<readonly TaskRecord[]>;
  };
  readonly conversations: {
    list(userId: string, limit: number): Promise<readonly ConversationDoc[]>;
  };
  readonly conversationTurns: {
    findLatestTurn(
      businessId: string,
      conversationId: string
    ): Promise<ConversationTurn | undefined>;
  };
  readonly agents: {
    list(): readonly SoulAgent[];
    mayInvoke(agent: SoulAgent, principal: { id: string; kind: "user" }): Promise<boolean>;
  };
}

export interface SlackHomeProjectionInput {
  readonly businessId: string;
  readonly principalId: string;
  readonly principalRef: string;
  readonly roles: readonly string[];
}

function slackText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "¦");
}

function link(url: string, label: string): string {
  return `<${url}|${slackText(label)}>`;
}

function routineApprovalLabel(row: RoutineApproval): string {
  const payload =
    row.payload !== null && typeof row.payload === "object"
      ? (row.payload as Record<string, unknown>)
      : {};
  const routine =
    typeof payload.routineSlug === "string" ? payload.routineSlug : "Routine approval";
  const state = typeof payload.stateName === "string" ? ` — ${payload.stateName}` : "";
  return `Approval: ${slackText(routine)}${slackText(state)}`;
}

function agentLabel(agent: SoulAgent): string {
  const label = agent.frontmatter.label;
  return typeof label === "string" && label.length > 0 ? label : agent.name;
}

function conversationLabel(conversation: ConversationDoc): string {
  return conversation.title?.trim() || "Untitled Chat";
}

export class SlackHomeProjectionService {
  constructor(private readonly deps: SlackHomeProjectionDeps) {}

  async load(input: SlackHomeProjectionInput): Promise<SlackHomeProjection> {
    const [toolApprovals, routineApprovals, tasks, conversations] = await Promise.all([
      this.deps.toolApprovals?.listPendingFor({
        businessId: input.businessId,
        principal: input.principalRef,
      }) ?? [],
      this.deps.routineApprovals?.listPendingFor({
        businessId: input.businessId,
        roles: input.roles,
      }) ?? [],
      this.deps.tasks?.listForPrincipal(input.businessId, input.principalId, input.roles, false) ??
        [],
      this.deps.conversations.list(input.principalId, CONVERSATION_CANDIDATE_LIMIT),
    ]);

    const needsYou = [
      ...toolApprovals.map((approval) => `Approval: ${slackText(approval.toolName)}`),
      ...routineApprovals.map(routineApprovalLabel),
      ...tasks.map((task) => `Task: ${slackText(task.title)}`),
    ].slice(0, SECTION_LIMIT);

    const conversationTurns = await Promise.all(
      conversations.map(async (conversation) => ({
        conversation,
        turn: await this.deps.conversationTurns.findLatestTurn(input.businessId, conversation._id),
      }))
    );
    const runningNow = conversationTurns
      .filter(
        ({ turn }) => turn?.runId !== null && ["pending", "running"].includes(turn?.status ?? "")
      )
      .slice(0, SECTION_LIMIT)
      .map(({ conversation, turn }) =>
        link(
          `${this.deps.webOrigin}/runs/${encodeURIComponent(turn?.runId ?? "")}`,
          conversationLabel(conversation)
        )
      );
    const recentWork = conversationTurns
      .filter(({ turn }) => turn?.status === "succeeded" || turn?.status === "failed")
      .slice(0, SECTION_LIMIT)
      .map(({ conversation }) =>
        link(
          `${this.deps.webOrigin}/chat/${encodeURIComponent(conversation._id)}`,
          conversationLabel(conversation)
        )
      );

    const authorizedAgents = await Promise.all(
      this.deps.agents.list().map(async (agent) => ({
        agent,
        mayInvoke: await this.deps.agents.mayInvoke(agent, {
          id: input.principalId,
          kind: "user",
        }),
      }))
    );
    const agents = authorizedAgents
      .filter(({ mayInvoke }) => mayInvoke)
      .slice(0, SECTION_LIMIT)
      .map(({ agent }) =>
        link(`${this.deps.webOrigin}/agents/${encodeURIComponent(agent.name)}`, agentLabel(agent))
      );

    return {
      askUrl: `${this.deps.webOrigin}/chats`,
      needsYou,
      runningNow,
      agents,
      recentWork,
    };
  }
}
