import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { LlmNotConfiguredError, type LlmService, UnknownModelError } from "@tulipfarm/llm";
import type { SoulLoader } from "@tulipfarm/soul";
import { generateText, type ModelMessage, streamText } from "ai";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stringify as stringifyYaml } from "yaml";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import { assembleSystemPrompt } from "../context/assemble";
import { DOMAIN_EVENTS } from "../domain-events";
import type { GuardContext, GuardrailsService } from "../guardrails";
import type { KnowledgeService } from "../knowledge/service";
import { MAX_TOOL_STEPS } from "../memory/limits";
import type { WorkingMemoryService } from "../memory/service";
import { parsePaginationQuery } from "../pagination";
import {
  EXCLUSIVE_SOUL_WRITE_TOOLS,
  GENERAL_ASSISTANT_NAME,
  getPlatformAgent,
  resolveAgent,
} from "../soul/agents/registry";
import { BUILTIN_SKILLS } from "../soul/skills/builtin-skills";
import { type EagerSkill, listAvailableSkills, listEagerSkills } from "../soul/skills/registry";
import { BatchCoordinator } from "../tools/batch-executor";
import type { RunToolCallGuard, ToolRegistry } from "../tools/registry";
import type { ToolCallResult } from "../tools/types";
import { ApprovalRegistry, makeApprovalGate } from "./approvals";
import { compactHistory, estimateTokens } from "./compaction";
import type { ConversationDoc, ConversationRepo } from "./conversations";
import {
  fromAssistantParts,
  fromAssistantText,
  fromToolResult,
  fromUserText,
  type MessageDoc,
  type MessagePart,
  type MessageRepo,
  toModelMessage,
} from "./messages";
import { attachToStream, type OutputScan, runChatStream } from "./producer";
import { MessageSchema } from "./schemas";
import { writeSseHeaders } from "./sse";
import { makeStreamEmitter } from "./stream-emitter";
import type { StreamHub } from "./stream-hub";
import type { StreamResumeRepo } from "./stream-resume";
import { buildAndStoreTitle } from "./title";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Instruction prefix for the quick-tier compaction summarizer (CTX-V1-001). */
const SUMMARY_PROMPT =
  "Summarize the earlier portion of this conversation transcript into a concise, " +
  "information-dense recap. Preserve facts, decisions, names, numbers, and any open " +
  "tasks the assistant must remember to continue. Write only the summary.";

interface ChatBody {
  conversationId?: string;
  message: { role: "user"; content: string };
  model?: string;
  agentId?: string;
  autonomy?: "full" | "supervised" | "approval-required" | "manual";
  hasTools?: boolean;
  llmDecision?: boolean;
  // Per-turn `/skill` + `#resource` tags from the composer (ephemeral, like `model`). Skill names
  // get their body eagerly injected into `<skills>`; resource type names get their schema injected
  // into `<eager-resources>` — for THIS turn only. Unknown names are ignored.
  skills?: string[];
  resources?: string[];
}

const ChatBodySchema = {
  type: "object",
  required: ["message"],
  additionalProperties: false,
  properties: {
    conversationId: { type: "string" },
    message: {
      type: "object",
      required: ["role", "content"],
      additionalProperties: false,
      properties: {
        role: { type: "string", enum: ["user"] },
        content: { type: "string", minLength: 1 },
      },
    },
    model: { type: "string", minLength: 1, pattern: "^\\S+$" },
    agentId: { type: "string", minLength: 1 },
    autonomy: { type: "string", enum: ["full", "supervised", "approval-required", "manual"] },
    hasTools: { type: "boolean" },
    llmDecision: { type: "boolean" },
    skills: { type: "array", items: { type: "string", minLength: 1 } },
    resources: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

/** Per-turn observability record (AC4): which model served the turn and whether an override applied. */
export function buildTurnLog(args: {
  conversationId: string;
  userId: string;
  requestedModel: string | undefined;
  resolvedModelId: string;
  isNewConversation: boolean;
}): {
  conversationId: string;
  userId: string;
  requestedModel: string | null;
  overrideApplied: boolean;
  resolvedModelId: string;
  isNewConversation: boolean;
} {
  return {
    conversationId: args.conversationId,
    userId: args.userId,
    requestedModel: args.requestedModel ?? null,
    overrideApplied: args.requestedModel != null,
    resolvedModelId: args.resolvedModelId,
    isNewConversation: args.isNewConversation,
  };
}

/**
 * Resolve the resume cursor: the `Last-Event-ID` header (set automatically by an
 * `EventSource` on reconnect) takes precedence over the `?lastEventId=` query. A
 * missing/invalid value means "from the start" (seq 0).
 */
export function parseLastEventId(
  header: string | string[] | undefined,
  query: number | undefined
): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return typeof query === "number" && query >= 0 ? query : 0;
}

/** The subset of an AI SDK `StepResult` that persistence needs. */
interface PersistableStep {
  text: string;
  finishReason: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: ReadonlyArray<{ toolCallId: string; toolName: string; output: unknown }>;
}

/**
 * Persist one finished `streamText` step. A tool step yields an assistant message holding the
 * tool-call parts (plus any text) followed by a tool message holding the results; a final text step
 * yields a plain assistant message. Errored or empty steps persist nothing. Exported for tests.
 */
/**
 * Producing-context stamped onto each assistant message's metadata so a down-vote (which references a
 * message id) can later be traced to what generated it — the model tier is per-turn ephemeral and the
 * conversation's agent_id is mutated by handoffs, so neither is recoverable from the message alone.
 */
export interface MessageProvenance {
  model?: string;
  agentId: string;
}

// Attach provenance to an assistant `MessageDoc` (tool messages aren't rated, so they're left bare).
function withProvenance(doc: MessageDoc, provenance?: MessageProvenance): MessageDoc {
  if (provenance) doc.metadata = { ...doc.metadata, provenance };
  return doc;
}

export async function persistStep(
  messageRepo: MessageRepo,
  conversationId: string,
  step: PersistableStep,
  onError: (err: unknown) => void,
  // The turn's pre-generated reply id, claimed once by the first final-text message so the live
  // reply (and the row feedback references) share an id. Tool-call steps keep their own ids.
  replyIdHolder?: { id?: string },
  // The model + agent that produced this step, stamped into the assistant message's metadata.
  provenance?: MessageProvenance
): Promise<void> {
  if (step.finishReason === "error") return;

  if (step.toolCalls.length > 0) {
    const parts: MessagePart[] = [];
    if (step.text) parts.push({ type: "text", text: step.text });
    for (const tc of step.toolCalls) {
      parts.push({
        type: "tool-call",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.input,
      });
    }
    await messageRepo
      .create(withProvenance(fromAssistantParts(conversationId, parts), provenance))
      .catch(onError);

    if (step.toolResults.length > 0) {
      const resultParts: MessagePart[] = step.toolResults.map((tr) => ({
        type: "tool-result",
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        result: tr.output,
      }));
      await messageRepo.create(fromToolResult(conversationId, resultParts)).catch(onError);
    }
    return;
  }

  if (step.text) {
    // Claim the pre-generated reply id for this (final-text) message, once per turn; later text
    // steps fall back to a fresh id.
    const id = replyIdHolder?.id;
    if (replyIdHolder) replyIdHolder.id = undefined;
    await messageRepo
      .create(withProvenance(fromAssistantText(conversationId, step.text, id), provenance))
      .catch(onError);
  }
}

// @fastify/cors adds CORS headers on the normal reply path, but `reply.hijack()` (used for the SSE
// stream) bypasses it — so a cross-origin browser `fetch` is blocked and X-Conversation-Id is unreadable.
// Copy the headers the cors hook already set onto the raw response.
function corsPassthrough(reply: FastifyReply): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-expose-headers",
    "vary",
  ]) {
    const value = reply.getHeader(name);
    if (typeof value === "string") out[name] = value;
    else if (typeof value === "number") out[name] = String(value);
    else if (Array.isArray(value)) out[name] = value.join(", ");
  }
  return out;
}

export function registerChatRoutes(
  app: FastifyInstance,
  llmService: LlmService,
  repo: ConversationRepo,
  messageRepo: MessageRepo,
  streamRepo: StreamResumeRepo,
  hub: StreamHub,
  requireAuth: PreHandler,
  workingMemory?: WorkingMemoryService,
  knowledge?: KnowledgeService,
  soulLoader?: SoulLoader,
  events?: EventEmitter,
  toolRegistry?: ToolRegistry,
  approvals?: ApprovalRegistry,
  guardrails?: GuardrailsService
): void {
  // One in-process approval registry shared by the chat turn (which suspends gated tools) and the
  // decide route (which resolves them). Single-instance V1 — see chat/approvals.ts.
  const approvalRegistry = approvals ?? new ApprovalRegistry();

  app.post(
    "/api/v1/chat",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Run one chat turn (streamed, AI SDK data-stream protocol). An optional `model` " +
          "(tier name or model id) overrides the model for this turn only; it is never persisted.",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: ChatBodySchema,
        response: { 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 503: ErrorSchema },
      },
    },
    async (req, reply) => {
      const user = req.user as UserDoc;
      const body = req.body as ChatBody;

      // 1. Load or create the conversation (before any streaming).
      let convo: ConversationDoc;
      let isNew: boolean;
      if (body.conversationId) {
        const found = await repo.findById(body.conversationId);
        if (!found || found.userId !== user._id) {
          return reply.code(404).send({ error: "conversation not found" });
        }
        convo = found;
        isNew = false;
      } else {
        const now = new Date();
        convo = {
          _id: randomUUID(),
          userId: user._id,
          agentId: body.agentId,
          model: undefined,
          createdAt: now,
          updatedAt: now,
        };
        await repo.create(convo);
        isNew = true;
        // Best-effort, off the turn's critical path: derive a title from the first message via the
        // quick tier and persist it asynchronously. The stream below is never blocked on this, and a
        // failure (quick tier down, persistence error) degrades to a truncated-prompt fallback.
        void buildAndStoreTitle({
          repo,
          getModel: () => llmService.getModel("quick"),
          id: convo._id,
          prompt: body.message.content,
          log: req.log,
        });
      }

      // 2. Resolve the model synchronously so a bad request returns before headers go out.
      //    sessionModel = per-turn override (ephemeral); model = conversation default (persisted).
      let selected: ReturnType<LlmService["select"]>;
      try {
        selected = llmService.select({
          sessionModel: body.model,
          model: convo.model,
          autonomy: body.autonomy,
          hasTools: body.hasTools,
          llmDecision: body.llmDecision,
        });
      } catch (err) {
        if (err instanceof UnknownModelError) return reply.code(400).send({ error: err.message });
        if (err instanceof LlmNotConfiguredError)
          return reply.code(503).send({ error: err.message });
        throw err;
      }
      // The concrete model id that served this turn — stamped into each assistant message's
      // provenance (the tier is otherwise ephemeral: never persisted on the conversation).
      const resolvedModelId = (selected as { modelId?: string }).modelId;

      // 3. Per-turn observability log (AC4).
      req.log.info(
        buildTurnLog({
          conversationId: convo._id,
          userId: user._id,
          requestedModel: body.model,
          resolvedModelId: resolvedModelId ?? "",
          isNewConversation: isNew,
        }),
        "chat turn"
      );

      // 4. Build history + persist the user turn (survives an aborted stream). The full system
      //    prompt is reconstructed every turn from durable stores in a fixed block order
      //    (CONTEXT-ENGINE §1), so the cacheable prefix is byte-stable across turns (AC-V1-001).
      const history = await messageRepo.listByConversation(convo._id, 1000);
      const messages: ModelMessage[] = [];
      const agent = resolveAgent(soulLoader, convo.agentId);
      const platformAgent = getPlatformAgent(agent.name);
      // Memory + governance + soul skills are conversation-scoped, so fetch once and reuse for both
      // the front desk and any handoff target. `buildSystemFor` assembles a per-agent system prompt:
      // the agent's body + its inbuilt forge skills (frontmatter only; bodies pulled on demand via
      // load_skill). Only the Information Architect carries forge skills today.
      const memoryList = workingMemory ? await workingMemory.list(user._id) : [];
      const governanceDocs = knowledge ? await knowledge.governanceDocuments() : [];
      const soulAvailableSkills = listAvailableSkills(soulLoader);
      const soulEagerSkills = listEagerSkills(soulLoader);
      // Per-turn `/skill` + `#resource` tags (ephemeral). Resolve names → bodies / schemas once and
      // eagerly inject; unknown names are dropped (the composer only offers real ones). Tagged skills
      // are merged with the soul's own eager skills, deduped by name so an already-eager skill isn't
      // injected twice. Resource schemas render to YAML, matching the resource-types API surface.
      const turnEagerSkills: EagerSkill[] = (body.skills ?? [])
        .map((name) => soulLoader?.skills.get(name))
        .filter(
          (s): s is NonNullable<typeof s> => s != null && s.frontmatter._pendingAudit !== true
        )
        .map((s) => ({ name: s.name, body: s.body }));
      // Keep the soul's sorted eager-skill prefix intact (AC-V1-001 cache stability) and append only
      // the genuinely-new turn-tagged skills, deduped — a tagged skill that is already eager neither
      // duplicates nor shifts position.
      const seenSkillNames = new Set(soulEagerSkills.map((s) => s.name));
      const extraTurnSkills: EagerSkill[] = [];
      for (const skill of turnEagerSkills) {
        if (seenSkillNames.has(skill.name)) continue;
        seenSkillNames.add(skill.name);
        extraTurnSkills.push(skill);
      }
      const mergedEagerSkills = [...soulEagerSkills, ...extraTurnSkills];
      const turnTaggedResources = (body.resources ?? [])
        .map((type) => soulLoader?.resources.get(type))
        .filter((r): r is NonNullable<typeof r> => r != null)
        .map((r) => ({ name: r.name, schema: stringifyYaml(r.schema) }));
      const buildSystemFor = (a: typeof agent, pa: typeof platformAgent): string => {
        const forgeAvailable = (pa?.forgeSkills ?? [])
          .map((n) => BUILTIN_SKILLS.get(n))
          .filter((s): s is NonNullable<typeof s> => s !== undefined)
          .map((s) => ({ name: s.name, description: s.description }));
        return assembleSystemPrompt({
          agentId: a.name,
          domain: typeof a.frontmatter.domain === "string" ? a.frontmatter.domain : null,
          tenantId: "default",
          personality: a.body,
          memory: memoryList,
          governanceDocs,
          availableSkills: [...soulAvailableSkills, ...forgeAvailable],
          eagerSkills: mergedEagerSkills,
          taggedResources: turnTaggedResources,
        });
      };
      const system = buildSystemFor(agent, platformAgent);
      // Compaction (CTX-V1-001/002): over budget → summarize the oldest turns once into a durable
      // `summary` row; recent turns stay verbatim. Best-effort — a summarize failure falls back to
      // the full (filtered) history so the turn still runs. Statelessness preserved: this only
      // changes which history rows are rendered, not the per-turn reconstruction.
      const rendered = await compactHistory({
        docs: history.items,
        conversationId: convo._id,
        extraTokens: estimateTokens(system) + estimateTokens(body.message.content),
        messageRepo,
        summarize: (transcript) =>
          generateText({
            model: llmService.getModel("quick"),
            prompt: `${SUMMARY_PROMPT}\n\n${transcript}`,
          }).then((r) => r.text),
        log: req.log,
      });
      if (system) messages.push({ role: "system", content: system });
      messages.push(...rendered.map(toModelMessage), {
        role: "user",
        content: body.message.content,
      });
      await messageRepo.create(fromUserText(convo._id, body.message.content));
      await repo.touch(convo._id);

      // 5. Stream the assistant reply over SSE. Each event carries an `id` so a dropped
      //    connection can reconnect via Last-Event-ID; the producer runs detached so the
      //    turn finishes (and keeps buffering) even after the client disconnects.
      const streamId = randomUUID();
      // Pre-generate the reply's message id and hand it to the client up front (X-Message-Id, like
      // X-Stream-Id), so a thumbs up/down on the just-streamed reply can reference a server-known id.
      // `persistStep` writes the final-text message under it (see the holder below).
      const replyMessageId = randomUUID();
      const replyIdHolder: { id?: string } = { id: replyMessageId };
      if (isNew) reply.raw.setHeader("X-Conversation-Id", convo._id);
      writeSseHeaders(reply.raw, {
        "X-Stream-Id": streamId,
        "X-Message-Id": replyMessageId,
        ...corsPassthrough(reply),
      });
      reply.hijack();
      hub.register(streamId);
      // Shared per-turn emitter: the producer loop AND the approval gate emit through it, so
      // out-of-band approval events stay on one monotonic, serialized seq (see stream-emitter.ts).
      const emitter = makeStreamEmitter(streamId, { repo: streamRepo, hub, log: req.log });

      // 6. Guardrails (GR-V1-001). Captured into `gr` so the tool-call/output closures narrow
      //    cleanly. The input stage runs after the emitter exists (so a block can persist its
      //    events for resume) and before tool build / streamText. The persisted user turn keeps the
      //    original text; only the messages sent to the LLM see a transform.
      const gr = guardrails;
      const guardCtx: GuardContext = {
        userId: user._id,
        agentId: agent.name,
        conversationId: convo._id,
        autonomy: body.autonomy,
      };
      if (gr) {
        const inResult = await gr.runInput(body.message.content, guardCtx);
        if (inResult.blocked) {
          await emitter.emit("guardrail_block", {
            stage: "input",
            guard: inResult.guard,
            reason: inResult.reason,
            message: inResult.message,
          });
          await emitter.emit("finish", { reason: "guardrail_block" });
          hub.finish(streamId);
          void attachToStream(reply.raw, streamId, 0, { repo: streamRepo, hub });
          return;
        }
        messages[messages.length - 1] = { role: "user", content: inResult.value };
      }

      const coordinator = new BatchCoordinator();
      const fullResultCache = new Map<string, ToolCallResult>();
      // Tool-call stage (AC-V1-002): a block returns a denial the LLM sees (the turn continues),
      // not a `guardrail_block` SSE. Undefined guardrails → byte-identical to before.
      const runToolCallGuard: RunToolCallGuard | undefined = gr
        ? async ({ tool, args }) => {
            const r = await gr.runToolCall(
              { toolName: tool.name, tier: tool.tier, args },
              guardCtx
            );
            return r.blocked
              ? { blocked: true, reason: `${r.guard}: ${r.reason}` }
              : { blocked: false, args: r.value.args };
          }
        : undefined;
      // Output stage (AC-V1-003): the producer buffers text segments and scans each before
      // emitting; a block drops the text and emits `guardrail_block` + `finish`.
      const scanOutput = gr
        ? async (text: string): Promise<OutputScan> => {
            const r = await gr.runOutput(text, guardCtx);
            return r.blocked
              ? { blocked: true, guard: r.guard, reason: r.reason, message: r.message }
              : { blocked: false, text: r.value };
          }
        : undefined;

      // Per-agent tool scoping: the Information Architect is filtered to its forge allowlist; every
      // other agent (the GeneralAssistant front desk + user soul agents) gets all registered tools
      // EXCEPT the IA-exclusive soul writes — so only the IA can author/edit soul artifacts.
      const computeAllowed = (pa: typeof platformAgent): ReadonlySet<string> | undefined => {
        if (!(toolRegistry && toolRegistry.getAll().length > 0)) return undefined;
        if (pa?.toolAllowlist) return new Set(pa.toolAllowlist);
        return new Set(
          toolRegistry
            .getAll()
            .map((t) => t.name)
            .filter((n) => !EXCLUSIVE_SOUL_WRITE_TOOLS.has(n))
        );
      };

      // The user's (guarded) request — handed to a transfer target as a clean slate so the front
      // desk's framed history doesn't read as prompt injection (the target's own prompt says who it
      // is, mirroring the canary handoff).
      const lastContent = messages[messages.length - 1]?.content;
      const userContent = typeof lastContent === "string" ? lastContent : body.message.content;

      // Same-turn agent loop (delegation): the active agent runs first; if it calls
      // `transfer_to_agent` the conversation's active agent switches (persisted) and the target
      // continues IN THE SAME SSE stream; `complete_task` hands control back to the GeneralAssistant.
      // Each agent gets its own streamText tool loop; we suppress the per-agent `finish` part and
      // emit exactly one synthetic finish after the chain ends.
      const MAX_HANDOFF_DEPTH = 4;
      async function* agentTurnStream(): AsyncGenerator<unknown> {
        let activeAgent = agent;
        let activePlatform = platformAgent;
        let turnMessages = messages;
        // Set once we've queued the GeneralAssistant's closing confirmation after a `complete_task`,
        // so the next iteration runs that wrap-up turn and then ends.
        let closingTurn = false;

        for (let depth = 0; depth < MAX_HANDOFF_DEPTH; depth++) {
          const turnTools =
            toolRegistry && toolRegistry.getAll().length > 0
              ? toolRegistry.buildToolSet(
                  { userId: user._id, agentId: activeAgent.name, autonomy: body.autonomy },
                  coordinator,
                  fullResultCache,
                  makeApprovalGate(approvalRegistry, emitter),
                  runToolCallGuard,
                  computeAllowed(activePlatform)
                )
              : undefined;

          const result = streamText({
            model: selected,
            messages: turnMessages,
            tools: turnTools,
            // Stop the agent's own loop at the step budget, or as soon as it hands off / completes —
            // so control returns to this loop without the agent rambling after the control tool.
            stopWhen: ({ steps }) => {
              if (steps.length >= MAX_TOOL_STEPS) return true;
              const last = steps[steps.length - 1];
              return (last?.toolCalls ?? []).some(
                (c) => c.toolName === "transfer_to_agent" || c.toolName === "complete_task"
              );
            },
            onError: ({ error }) => {
              req.log.error({ err: error, conversationId: convo._id }, "chat stream error");
            },
            // Persist each finished step (text and/or tool-call + tool-result) so the durable history
            // captures the whole tool loop across every agent in the chain. `activeAgent.name` is the
            // agent that produced THIS step (it changes across handoffs), recorded as provenance.
            onStepFinish: (step) =>
              persistStep(
                messageRepo,
                convo._id,
                step as unknown as PersistableStep,
                (e) => req.log.error({ err: e, conversationId: convo._id }, "persist failed"),
                replyIdHolder,
                { model: resolvedModelId, agentId: activeAgent.name }
              ),
          });

          let control:
            | { type: "transfer"; target: string; reason?: string }
            | { type: "complete"; summary?: string }
            | undefined;
          let errored = false;
          for await (const part of result.fullStream) {
            const p = part as { type?: string; toolName?: string; toolCallId?: string };
            // Suppress each agent's own terminal `finish`; one synthetic finish closes the whole turn.
            if (p.type === "finish") continue;
            if (p.type === "error") errored = true;
            if (
              p.type === "tool-result" &&
              (p.toolName === "transfer_to_agent" || p.toolName === "complete_task")
            ) {
              const full = fullResultCache.get(p.toolCallId as string);
              if (full?.success) {
                const data = full.data as Record<string, unknown>;
                control =
                  p.toolName === "transfer_to_agent"
                    ? {
                        type: "transfer",
                        target: String(data.agentId),
                        reason: data.message ? String(data.message) : undefined,
                      }
                    : {
                        type: "complete",
                        summary: data.summary ? String(data.summary) : undefined,
                      };
              }
            }
            yield part;
          }

          if (errored) return; // a terminal `error` was already yielded by the producer
          if (closingTurn) break; // the GeneralAssistant's closing confirmation just streamed
          if (control?.type === "transfer" && depth < MAX_HANDOFF_DEPTH - 1) {
            await repo.setAgent(convo._id, control.target);
            activeAgent = resolveAgent(soulLoader, control.target);
            activePlatform = getPlatformAgent(activeAgent.name);
            const handoffUser = control.reason
              ? `${userContent}\n\n(Handoff context: ${control.reason})`
              : userContent;
            // Clean slate for the target: its own system prompt + the user's original request.
            turnMessages = [
              { role: "system", content: buildSystemFor(activeAgent, activePlatform) },
              { role: "user", content: handoffUser },
            ];
            continue;
          }
          if (control?.type === "complete" && depth < MAX_HANDOFF_DEPTH - 1) {
            // Control returns to the front desk, which streams a brief confirmation of what the
            // specialist just did — otherwise the turn ends on a silent (collapsed) tool result.
            await repo.setAgent(convo._id, GENERAL_ASSISTANT_NAME);
            activeAgent = resolveAgent(soulLoader, GENERAL_ASSISTANT_NAME);
            activePlatform = getPlatformAgent(activeAgent.name);
            const summary = control.summary ?? "completed the requested work";
            turnMessages = [
              { role: "system", content: buildSystemFor(activeAgent, activePlatform) },
              { role: "user", content: userContent },
              {
                role: "assistant",
                content: `(Internal note — the Information Architect handled that and reported: ${summary})`,
              },
              {
                role: "user",
                content:
                  "In one short, friendly sentence, confirm what was just created or done, and suggest one relevant next step. Do not call any tools.",
              },
            ];
            closingTurn = true;
            continue;
          }
          if (control?.type === "complete") {
            await repo.setAgent(convo._id, GENERAL_ASSISTANT_NAME);
          }
          break;
        }

        // A completed turn feeds the knowledge AgentConversationSource (AC-V1-002).
        events?.emit(DOMAIN_EVENTS.CONVERSATION_COMPLETED, { conversationId: convo._id });
        yield { type: "finish", finishReason: "stop" };
      }

      // Attach this connection (live from seq 0) and start the detached producer over the loop.
      void attachToStream(reply.raw, streamId, 0, { repo: streamRepo, hub });
      void runChatStream(streamId, agentTurnStream(), {
        emitter,
        hub,
        log: req.log,
        fullResultCache,
        scanOutput,
      });
    }
  );

  app.get(
    "/api/v1/chat/streams/:streamId",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Resume an in-flight or recently-finished chat stream over SSE. Send the last " +
          "received event id as the `Last-Event-ID` header (or `?lastEventId=`): buffered " +
          "events after it are replayed, then the connection attaches to the live tail.",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["streamId"],
          properties: { streamId: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: { lastEventId: { type: "integer", minimum: 0 } },
        },
        response: { 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { streamId } = req.params as { streamId: string };
      const afterSeq = parseLastEventId(
        req.headers["last-event-id"],
        (req.query as { lastEventId?: number }).lastEventId
      );

      // Unknown stream (never existed or already GC'd) → 404. A live stream or any
      // buffered row counts as known, even if the client already has every event.
      if (!hub.isLive(streamId)) {
        const existing = await streamRepo.listAfter(streamId, 0);
        if (existing.length === 0) {
          return reply.code(404).send({ error: "stream not found" });
        }
      }

      writeSseHeaders(reply.raw, corsPassthrough(reply));
      reply.hijack();
      await attachToStream(reply.raw, streamId, afterSeq, { repo: streamRepo, hub });
    }
  );

  app.get(
    "/api/v1/conversations",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "List the authenticated user's conversations, newest-first (Recent chats + Chats page). " +
          "`q` filters by title (case-insensitive substring); `limit` defaults to 50 (max 200).",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: {
            q: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 200 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              conversations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: ["string", "null"] },
                    agentId: { type: ["string", "null"] },
                    starred: { type: "boolean" },
                    createdAt: { type: "string" },
                    updatedAt: { type: "string" },
                  },
                  required: ["id", "title", "agentId", "starred", "createdAt", "updatedAt"],
                },
              },
            },
            required: ["conversations"],
          },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const user = req.user as UserDoc;
      const { q, limit } = req.query as { q?: string; limit?: number };
      const convos = await repo.list(user._id, Math.min(limit ?? 50, 200), q?.trim() || undefined);
      return reply.send({
        conversations: convos.map((c) => ({
          id: c._id,
          title: c.title ?? null,
          agentId: c.agentId ?? null,
          starred: c.starred ?? false,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
      });
    }
  );

  app.put(
    "/api/v1/conversations/:id",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Update a conversation's title (rename) and/or starred flag. Owner-only. At least one " +
          "field is required.",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            starred: { type: "boolean" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: ["string", "null"] },
              agentId: { type: ["string", "null"] },
              starred: { type: "boolean" },
              createdAt: { type: "string" },
              updatedAt: { type: "string" },
            },
            required: ["id", "title", "agentId", "starred", "createdAt", "updatedAt"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const user = req.user as UserDoc;
      const { id } = req.params as { id: string };
      const body = req.body as { title?: string; starred?: boolean };

      // Owner-only mutation (unlike the tenant-open reads): a non-owner — or a missing id — is a 404.
      const convo = await repo.findById(id);
      if (!convo || convo.userId !== user._id) {
        return reply.code(404).send({ error: "conversation not found" });
      }

      if (body.title !== undefined) {
        const title = body.title.trim();
        if (title === "") return reply.code(400).send({ error: "title must not be blank" });
        await repo.setTitle(id, title);
      }
      if (body.starred !== undefined) await repo.setStarred(id, body.starred);

      const updated = await repo.findById(id);
      if (!updated) {
        return reply.code(404).send({ error: "conversation not found" });
      }
      return reply.send({
        id: updated._id,
        title: updated.title ?? null,
        agentId: updated.agentId ?? null,
        starred: updated.starred ?? false,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      });
    }
  );

  app.get(
    "/api/v1/conversations/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Fetch a conversation's metadata (tenant-open: any authenticated user).",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string" },
              userId: { type: ["string", "null"] },
              agentId: { type: ["string", "null"] },
              model: { type: ["string", "null"] },
              title: { type: ["string", "null"] },
              starred: { type: "boolean" },
              createdAt: { type: "string" },
              updatedAt: { type: "string" },
            },
            required: ["id", "createdAt", "updatedAt"],
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const convo = await repo.findById(id);
      if (!convo) {
        return reply.code(404).send({ error: "conversation not found" });
      }
      return reply.send({
        id: convo._id,
        userId: convo.userId ?? null,
        agentId: convo.agentId ?? null,
        model: convo.model ?? null,
        title: convo.title ?? null,
        starred: convo.starred ?? false,
        createdAt: convo.createdAt,
        updatedAt: convo.updatedAt,
      });
    }
  );

  app.get(
    "/api/v1/conversations/:id/messages",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "List a conversation's messages, oldest→newest, cursor-paginated " +
          "(tenant-open: any authenticated user).",
        tags: ["chat"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            cursor: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              messages: { type: "array", items: MessageSchema },
              nextCursor: { type: ["string", "null"] },
            },
            required: ["messages", "nextCursor"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const convo = await repo.findById(id);
      if (!convo) {
        return reply.code(404).send({ error: "conversation not found" });
      }

      const { limit, after } = parsePaginationQuery(req.query as Record<string, unknown>);
      const rawCursor = (req.query as Record<string, unknown>).cursor;
      if (typeof rawCursor === "string" && rawCursor !== "" && after === undefined) {
        return reply.code(400).send({ error: "invalid cursor" });
      }

      const result = await messageRepo.listByConversation(id, limit, after);
      return reply.send({ messages: result.items, nextCursor: result.nextCursor });
    }
  );
}
