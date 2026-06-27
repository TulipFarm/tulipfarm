import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { LlmNotConfiguredError, type LlmService, UnknownModelError } from "@tulipfarm/llm";
import type { SoulLoader } from "@tulipfarm/soul";
import { generateText, type ModelMessage, streamText } from "ai";
import type { FastifyReply, FastifyRequest } from "fastify";
import { stringify as stringifyYaml } from "yaml";
import type { A2uiSurfaceStore } from "../a2ui/surface-store";
import type { UserDoc } from "../auth/users";
import { DOMAIN_EVENTS } from "../domain-events";
import type { GuardContext, GuardrailsService } from "../guardrails";
import type { KnowledgeService } from "../knowledge/service";
import { MAX_TOOL_STEPS } from "../memory/limits";
import type { WorkingMemoryService } from "../memory/service";
import {
  GENERAL_ASSISTANT_NAME,
  getAgent,
  getPlatformAgent,
  resolveAgent,
} from "../soul/agents/registry";
import { buildSoulCatalogue } from "../soul/catalogue";
import { type EagerSkill, listAvailableSkills, listEagerSkills } from "../soul/skills/registry";
import { BatchCoordinator } from "../tools/batch-executor";
import type { RunToolCallGuard, ToolRegistry } from "../tools/registry";
import type { ToolCallResult } from "../tools/types";
import { type ApprovalRegistry, makeApprovalGate } from "./approvals";
import { compactHistory, estimateTokens } from "./compaction";
import type { ConversationDoc, ConversationRepo } from "./conversations";
import { fromUserText, type MessageRepo, toModelMessage } from "./messages";
import type { PendingInteractionRepo } from "./pending-interactions";
import { attachToStream, type OutputScan, runChatStream } from "./producer";
import { writeSseHeaders } from "./sse";
import { makeStreamEmitter } from "./stream-emitter";
import type { StreamHub } from "./stream-hub";
import type { StreamResumeRepo } from "./stream-resume";
import { assembleAgentSystemPrompt } from "./system-prompt";
import { buildAndStoreTitle } from "./title";
import {
  allowedToolNamesFor,
  availableToolsFor,
  buildTurnLog,
  type ChatBody,
  canGroundKnowledge,
  corsPassthrough,
  type PersistableStep,
  patchToolResult,
  persistStep,
  SUMMARY_PROMPT,
} from "./turn-helpers";

/**
 * Per-instance dependencies for one chat turn: the injected services plus the in-process state that
 * the chat turn shares with the stream-control routes (the abort-controller map) and the approval
 * route (the approval registry). Built once in `registerChatRoutes` and reused across turns.
 */
export interface ChatTurnContext {
  llmService: LlmService;
  repo: ConversationRepo;
  messageRepo: MessageRepo;
  streamRepo: StreamResumeRepo;
  hub: StreamHub;
  workingMemory?: WorkingMemoryService;
  knowledge?: KnowledgeService;
  soulLoader?: SoulLoader;
  events?: EventEmitter;
  toolRegistry?: ToolRegistry;
  guardrails?: GuardrailsService;
  approvalRegistry: ApprovalRegistry;
  pendingInteractions: PendingInteractionRepo;
  surfaceStore: A2uiSurfaceStore;
  streamControllers: Map<string, AbortController>;
}

/**
 * Run one chat turn (streamed, AI SDK data-stream protocol). Loads/creates the conversation, resolves
 * the model, assembles the per-turn system prompt + history, runs the guardrail input stage, then
 * streams the assistant reply over SSE — including the same-turn agent delegation loop. Hijacks the
 * reply and detaches the producer, so the turn finishes (and keeps buffering) past client disconnect.
 */
export async function runChatTurn(req: FastifyRequest, reply: FastifyReply, ctx: ChatTurnContext) {
  const {
    llmService,
    repo,
    messageRepo,
    streamRepo,
    hub,
    workingMemory,
    knowledge,
    soulLoader,
    events,
    toolRegistry,
    guardrails,
    approvalRegistry,
    pendingInteractions,
    surfaceStore,
    streamControllers,
  } = ctx;

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

  // 1b. Sticky @mention hand-off: a mid-conversation `@agent` mention re-targets the active
  //     agent. The tagged agent takes over this turn and persists as the conversation's agent
  //     until a different one is tagged. (New conversations already seed their agent from
  //     body.agentId above, so no switch/marker there.) Surfaced to the client as the same
  //     `agent-handoff` event a transfer emits (see agentTurnStream).
  let userSwitch: { from: string; to: string; reason: string } | undefined;
  // Compare against the EFFECTIVE current agent: a legacy row with no persisted agentId resolves
  // to the GeneralAssistant, so tagging it must read as a no-op (not a spurious GA→GA switch).
  const currentAgentId = convo.agentId ?? GENERAL_ASSISTANT_NAME;
  if (!isNew && body.agentId && body.agentId !== currentAgentId) {
    const target = getAgent(soulLoader, body.agentId); // platform OR soul agent; undefined if unknown
    if (target) {
      userSwitch = {
        from: currentAgentId,
        to: target.name,
        reason: "you mentioned this agent",
      };
      convo.agentId = target.name;
      try {
        await repo.setAgent(convo._id, target.name);
      } catch (e) {
        // Non-fatal: continue with the mutated in-memory convo.agentId rather than aborting the
        // turn on a transient DB error (other persistence in the stream is treated as non-fatal too).
        req.log.error(
          { err: e, conversationId: convo._id },
          "setAgent (user @mention switch) failed"
        );
      }
    }
    // unknown agentId → ignore, keep convo.agentId (the composer only offers real agents)
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
    if (err instanceof LlmNotConfiguredError) return reply.code(503).send({ error: err.message });
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
  // Repo catalogue for <soul-context> — conversation-scoped (same for the front desk and any
  // handoff target), so build it once and reuse across `buildSystemFor` calls.
  const soulCatalogue = buildSoulCatalogue(soulLoader);
  // Per-turn `/skill` + `#resource` tags (ephemeral). Resolve names → bodies / schemas once and
  // eagerly inject; unknown names are dropped (the composer only offers real ones). Tagged skills
  // are merged with the soul's own eager skills, deduped by name so an already-eager skill isn't
  // injected twice. Resource schemas render to YAML, matching the resource-types API surface.
  const turnEagerSkills: EagerSkill[] = (body.skills ?? [])
    .map((name) => soulLoader?.skills.get(name))
    .filter((s): s is NonNullable<typeof s> => s != null && s.frontmatter._pendingAudit !== true)
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
  // Per-turn `~knowledge` pins: resolve each documentId to its full page, drop unknown/inactive ones,
  // and inject as `<pinned-knowledge>` so the agent answers from (and cites) the user's chosen pages.
  const turnPinnedKnowledge = knowledge
    ? (await Promise.all((body.knowledgePages ?? []).map((id) => knowledge.getDocument(id))))
        .filter((d): d is NonNullable<typeof d> => d?.active === true)
        .map((d) => ({ id: d._id, title: d.title, content: d.content }))
    : [];
  const buildSystemFor = (a: typeof agent, pa: typeof platformAgent): string => {
    // Tools THIS agent may call — per-agent, so a handoff target gets its own scoped index.
    const tools = availableToolsFor(toolRegistry, pa);
    // Grounding+citation guidance AND the user's ~knowledge pins move together: both only go to an
    // agent that can actually cite (cite_sources in its scoped toolset). Otherwise a handoff target
    // without cite_sources (e.g. the IA) would receive pinned pages telling it to call a tool it lacks.
    const canCite = canGroundKnowledge(knowledge, tools);
    return assembleAgentSystemPrompt({
      agent: a,
      platformAgent: pa,
      memory: memoryList,
      governanceDocs,
      availableSkills: soulAvailableSkills,
      eagerSkills: mergedEagerSkills,
      taggedResources: turnTaggedResources,
      soulCatalogue,
      availableTools: tools,
      pinnedKnowledge: canCite ? turnPinnedKnowledge : [],
      knowledgeGrounding: canCite,
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
  // HITL resume: if this conversation is paused on an `ask_user`, the incoming message is the
  // ANSWER, not a new user turn — inject it as the pending tool-call's result and continue the run
  // (the model sees its own question answered). The answer is still persisted as a user message for
  // durable history; only THIS turn's model messages carry the patched tool-result.
  const pending = await pendingInteractions.findOpenByConversation(convo._id);
  if (system) messages.push({ role: "system", content: system });
  const renderedModel = rendered.map(toModelMessage);
  if (pending) {
    patchToolResult(renderedModel, pending.toolCallId, { answer: body.message.content });
    messages.push(...renderedModel);
  } else {
    messages.push(...renderedModel, { role: "user", content: body.message.content });
  }
  await messageRepo.create(fromUserText(convo._id, body.message.content));
  await repo.touch(convo._id);

  // 5. Stream the assistant reply over SSE. Each event carries an `id` so a dropped
  //    connection can reconnect via Last-Event-ID; the producer runs detached so the
  //    turn finishes (and keeps buffering) even after the client disconnects.
  const streamId = randomUUID();
  // Per-turn abort handle: the stop endpoint looks this up by streamId and aborts the LLM so the
  // turn halts (rather than running detached to completion). `streamText` reads `.signal` below.
  const abortController = new AbortController();
  streamControllers.set(streamId, abortController);
  // Pre-generate the reply's message id and hand it to the client up front (X-Message-Id, like
  // X-Stream-Id), so a thumbs up/down on the just-streamed reply can reference a server-known id.
  // `persistStep` writes the final-text message under it (see the holder below).
  const replyMessageId = randomUUID();
  const replyIdHolder: { id?: string } = { id: replyMessageId };
  if (isNew) reply.raw.setHeader("X-Conversation-Id", convo._id);
  writeSseHeaders(reply.raw, {
    "X-Stream-Id": streamId,
    "X-Message-Id": replyMessageId,
    // The agent handling this turn (from the @mention / conversation) so the client's header
    // indicator reflects it immediately; mid-turn handoffs then update it via agent-handoff events.
    "X-Agent-Id": agent.name,
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
      return; // pending interaction stays open — the user can re-submit the answer
    }
    // On resume the guarded answer goes back into the pending tool-result, not a trailing user msg.
    if (pending) patchToolResult(messages, pending.toolCallId, { answer: inResult.value });
    else messages[messages.length - 1] = { role: "user", content: inResult.value };
  }
  // The HITL answer is committed once it clears input guarding (or when no guard runs). Resolving
  // here — not before the guard — lets a blocked answer be re-submitted against the same pause.
  if (pending) await pendingInteractions.resolve(pending.id);

  const coordinator = new BatchCoordinator();
  const fullResultCache = new Map<string, ToolCallResult>();
  // Per-turn flag: get_client_context flips it true; side-effecting frontend actions are gated on
  // it (shared across the whole turn, including handoffs, so a context read carries forward).
  const contextRead = { value: false };
  // Tool-call stage (AC-V1-002): a block returns a denial the LLM sees (the turn continues),
  // not a `guardrail_block` SSE. Undefined guardrails → byte-identical to before.
  const runToolCallGuard: RunToolCallGuard | undefined = gr
    ? async ({ tool, args }) => {
        const r = await gr.runToolCall({ toolName: tool.name, tier: tool.tier, args }, guardCtx);
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

    // A user @mention switched the active agent before the turn began — surface it as the same
    // agent-handoff event a transfer would, ahead of the new agent's first output, so the client
    // renders the inline marker and moves the current-agent indicator.
    if (userSwitch) {
      yield {
        type: "agent-handoff",
        from: userSwitch.from,
        to: userSwitch.to,
        reason: userSwitch.reason,
      };
    }

    for (let depth = 0; depth < MAX_HANDOFF_DEPTH; depth++) {
      const turnTools =
        toolRegistry && toolRegistry.getAll().length > 0
          ? toolRegistry.buildToolSet(
              {
                userId: user._id,
                agentId: activeAgent.name,
                autonomy: body.autonomy,
                clientContext: body.clientContext,
                contextRead,
              },
              coordinator,
              fullResultCache,
              makeApprovalGate(approvalRegistry, emitter),
              runToolCallGuard,
              allowedToolNamesFor(toolRegistry, activePlatform)
            )
          : undefined;

      const result = streamText({
        model: selected,
        messages: turnMessages,
        // AI SDK v7 rejects `role: "system"` entries in `messages` by default; the per-turn prompt
        // is assembled as a leading system message (and re-seeded on handoff), so opt back in.
        allowSystemInMessages: true,
        tools: turnTools,
        // The stop endpoint aborts this signal to halt generation mid-turn (see streamControllers).
        abortSignal: abortController.signal,
        // Stop the agent's own loop at the step budget, or as soon as it hands off / completes —
        // so control returns to this loop without the agent rambling after the control tool.
        stopWhen: ({ steps }) => {
          if (steps.length >= MAX_TOOL_STEPS) return true;
          const last = steps[steps.length - 1];
          return (last?.toolCalls ?? []).some(
            (c) =>
              c.toolName === "transfer_to_agent" ||
              c.toolName === "complete_task" ||
              c.toolName === "ask_user" // HITL: end the turn cleanly with the form rendered
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
      // Set when this agent calls `ask_user`: the turn ends with the form rendered and a pending
      // interaction is persisted so the next request resumes with the user's answer.
      let pendingAsk:
        | { toolCallId: string; surfaceId: string | null; schema: Record<string, unknown> }
        | undefined;
      let errored = false;
      for await (const part of result.fullStream) {
        const p = part as { type?: string; toolName?: string; toolCallId?: string };
        // Suppress each agent's own terminal `finish`; one synthetic finish closes the whole turn.
        if (p.type === "finish") continue;
        if (p.type === "error") errored = true;
        if (p.type === "tool-result" && p.toolName === "ask_user") {
          const full = fullResultCache.get(p.toolCallId as string);
          if (full?.success) {
            const data = full.data as Record<string, unknown>;
            pendingAsk = {
              toolCallId: p.toolCallId as string,
              surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : null,
              schema: (data.schema as Record<string, unknown>) ?? {},
            };
          }
        }
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
      if (pendingAsk) {
        // HITL: end the turn with the form on screen and record the pause. The next request injects
        // the user's answer as this tool-call's result and resumes the run (see the resume path).
        await pendingInteractions.create({
          id: randomUUID(),
          conversationId: convo._id,
          toolCallId: pendingAsk.toolCallId,
          toolName: "ask_user",
          awaitedSchema: pendingAsk.schema,
          surfaceId: pendingAsk.surfaceId,
          createdAt: new Date(),
          resolvedAt: null,
        });
        break;
      }
      if (closingTurn) break; // the GeneralAssistant's closing confirmation just streamed
      if (control?.type === "transfer" && depth < MAX_HANDOFF_DEPTH - 1) {
        const fromAgent = activeAgent.name;
        await repo.setAgent(convo._id, control.target);
        activeAgent = resolveAgent(soulLoader, control.target);
        activePlatform = getPlatformAgent(activeAgent.name);
        // Surface the live switch so the client's current-agent indicator follows the handoff.
        yield {
          type: "agent-handoff",
          from: fromAgent,
          to: activeAgent.name,
          reason: control.reason,
        };
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
        const fromAgent = activeAgent.name;
        await repo.setAgent(convo._id, GENERAL_ASSISTANT_NAME);
        activeAgent = resolveAgent(soulLoader, GENERAL_ASSISTANT_NAME);
        activePlatform = getPlatformAgent(activeAgent.name);
        // Hand the indicator back to the front desk for the closing confirmation turn.
        yield { type: "agent-handoff", from: fromAgent, to: activeAgent.name };
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
    surfaceStore,
    conversationId: convo._id,
    abortSignal: abortController.signal,
  }).finally(() => streamControllers.delete(streamId));
}
