import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { LlmService, ResolvedModel } from "@tulipfarm/llm";
import { LlmNotConfiguredError, UnknownModelError } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import { generateText, type ModelMessage, streamText } from "ai";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import { stringify as stringifyYaml } from "yaml";
import type { A2uiSurfaceStore } from "../a2ui/artifact-surface";
import { type DurableApprovalGate, makeApprovalGate } from "../approvals/chat-gate";
import type { UserDoc } from "../auth/users";
import type { RunToolCallGuard, ToolRegistry } from "../broker/tool-adapter";
import { compactHistory, estimateTokens } from "../chat/compaction";
import type { ConversationDoc, ConversationRepo } from "../chat/conversations";
import { fromUserText, type MessageRepo, toModelMessage } from "../chat/messages";
import type { PendingInteractionRepo } from "../chat/pending-interactions";
import { attachToStream, type OutputScan, runChatStream } from "../chat/producer";
import { writeSseHeaders } from "../chat/sse";
import { makeStreamEmitter } from "../chat/stream-emitter";
import type { StreamHub } from "../chat/stream-hub";
import type { StreamResumeRepo } from "../chat/stream-resume";
import { assembleAgentSystemPrompt } from "../chat/system-prompt";
import { buildAndStoreTitle } from "../chat/title";
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
} from "../chat/turn-helpers";
import { DOMAIN_EVENTS } from "../domain-events";
import type { GuardContext, GuardrailsService } from "../guardrails";
import type { KnowledgeService } from "../knowledge/service";
import { MAX_TOOL_STEPS } from "../memory/limits";
import type { WorkingMemoryService } from "../memory/service";
import {
  attributeModel,
  extractStepUsage,
  extractToolCalls,
  type ObservableStep,
} from "../observability/capture";
import {
  DEFAULT_ASSISTANT_NAME,
  getAgent,
  getDefaultAssistant,
  resolveAgent,
} from "../soul/agents/registry";
import { buildSoulCatalogue } from "../soul/catalogue";
import { type EagerSkill, listAvailableSkills, listEagerSkills } from "../soul/skills/registry";
import { BatchCoordinator } from "../tools/batch-executor";
import type { ToolCallResult } from "../tools/types";

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
  approvalRegistry: DurableApprovalGate;
  pendingInteractions: PendingInteractionRepo;
  surfaceStore: A2uiSurfaceStore;
  streamControllers: Map<string, AbortController>;
}

/** Caller-supplied inputs for one turn — everything the HTTP layer contributed beyond the deps. */
export interface TurnInput {
  user: UserDoc;
  body: ChatBody;
  log: FastifyBaseLogger;
}

/** Early validation failure from prepareChatTurn; the HTTP wrapper maps it to a status code. */
export interface PrepareError {
  status: 400 | 404 | 503;
  error: string;
}

export function isPrepareError(value: PreparedTurn | PrepareError): value is PrepareError {
  return "status" in value;
}

/** Everything steps 1–4 produced, handed to startChatTurn to stream the reply. */
export interface PreparedTurn {
  convo: ConversationDoc;
  isNew: boolean;
  userSwitch?: { from: string; to: string; reason: string };
  agent: ReturnType<typeof resolveAgent>;
  platformAgent: ReturnType<typeof getDefaultAssistant>;
  resolved: ResolvedModel;
  resolvedModelId: string;
  messages: ModelMessage[];
  pending: Awaited<ReturnType<PendingInteractionRepo["findOpenByConversation"]>>;
  buildSystemFor: (
    a: ReturnType<typeof resolveAgent>,
    pa: ReturnType<typeof getDefaultAssistant>
  ) => string;
}

/** Handle over a launched turn. `done` resolves when the detached producer finishes. */
export interface TurnHandle {
  streamId: string;
  replyMessageId: string;
  conversationId: string;
  agentName: string;
  isNew: boolean;
  done: Promise<void>;
}

/**
 * Steps 1–4 of a chat turn: load/create the conversation, apply a sticky @mention switch, resolve
 * the model, assemble the per-turn system prompt + compacted history, and persist the user turn.
 * Pure of HTTP — callers are the SSE route wrapper (runChatTurn) and the headless entry
 * (runHeadlessChatTurn). Returns a PrepareError instead of throwing for caller-mappable failures.
 */
export async function prepareChatTurn(
  ctx: ChatTurnContext,
  input: TurnInput
): Promise<PreparedTurn | PrepareError> {
  const {
    llmService,
    repo,
    messageRepo,
    workingMemory,
    knowledge,
    soulLoader,
    events,
    toolRegistry,
    pendingInteractions,
  } = ctx;
  const { user, body, log } = input;

  // 1. Load or create the conversation (before any streaming).
  let convo: ConversationDoc;
  let isNew: boolean;
  if (body.conversationId) {
    const found = await repo.findById(body.conversationId);
    if (!found || found.userId !== user._id) {
      return { status: 404, error: "conversation not found" };
    }
    convo = found;
    isNew = false;
  } else {
    const now = new Date();
    const requestedAgentId = body.agentId;
    // Unknown agentId → normal chat (the composer only offers real agents); don't persist a
    // dangling reference.
    const validAgentId =
      requestedAgentId && getAgent(soulLoader, requestedAgentId) ? requestedAgentId : undefined;
    convo = {
      _id: randomUUID(),
      userId: user._id,
      agentId: validAgentId,
      model: undefined,
      createdAt: now,
      updatedAt: now,
    };
    await repo.create(convo);
    isNew = true;
    events?.emit(DOMAIN_EVENTS.CONVERSATION_CREATED, {
      conversationId: convo._id,
      actorId: user._id,
      agentId: validAgentId,
    });
    // Best-effort, off the turn's critical path: derive a title from the first message via the
    // quick tier and persist it asynchronously. The stream below is never blocked on this, and a
    // failure (quick tier down, persistence error) degrades to a truncated-prompt fallback.
    void buildAndStoreTitle({
      repo,
      getModel: () => llmService.getModel("quick"),
      id: convo._id,
      prompt: body.message.content,
      log,
    });
  }

  // 1b. Sticky @mention hand-off: a mid-conversation `@agent` mention re-targets the active
  //     agent. The tagged agent takes over this turn and persists as the conversation's agent
  //     until a different one is tagged. (New conversations already seed their agent from
  //     body.agentId above, so no switch/marker there.) Surfaced to the client as the same
  //     `agent-handoff` event a transfer emits (see agentTurnStream).
  let userSwitch: { from: string; to: string; reason: string } | undefined;
  // A conversation with no selected Agent is normal chat, not an implicit named Agent.
  const currentAgentId = convo.agentId ?? DEFAULT_ASSISTANT_NAME;
  if (!isNew && body.agentId && body.agentId !== currentAgentId) {
    const target = getAgent(soulLoader, body.agentId);
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
        log.error({ err: e, conversationId: convo._id }, "setAgent (user @mention switch) failed");
      }
    }
    // unknown agentId → ignore, keep convo.agentId (the composer only offers real agents)
  }

  // 2. Resolve the model synchronously so a bad request returns before headers go out.
  //    sessionModel = per-turn override (ephemeral); model = conversation default (persisted).
  let resolved: ResolvedModel;
  try {
    resolved = llmService.resolve({
      sessionModel: body.model,
      model: convo.model,
      autonomy: body.autonomy,
      hasTools: body.hasTools,
      llmDecision: body.llmDecision,
    });
  } catch (err) {
    if (err instanceof UnknownModelError) return { status: 400, error: err.message };
    if (err instanceof LlmNotConfiguredError) return { status: 503, error: err.message };
    throw err;
  }
  // The primary model id for this turn — stamped into each assistant message's provenance (the tier
  // is otherwise ephemeral: never persisted on the conversation). Under fallback the served model
  // can differ; observability reconciles via `resolved.chain` + the step's response model id.
  const resolvedModelId = resolved.modelId;

  // 3. Per-turn observability log (AC4).
  log.info(
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
  const platformAgent = getDefaultAssistant(agent.name);
  // Memory + governance + soul skills are conversation-scoped, so fetch once and reuse for both
  // the built-in assistant and any handoff target. `buildSystemFor` assembles a per-agent system
  // prompt: the agent's body + its inbuilt forge skills (frontmatter only; bodies pulled on demand
  // via `load_skill`).
  const memoryList = workingMemory ? await workingMemory.list(user._id) : [];
  const governancePages = knowledge ? await knowledge.governancePages() : [];
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
  // Per-turn `~knowledge` pins: resolve each pageId to its full page, drop unknown/inactive ones,
  // and inject as `<pinned-knowledge>` so the agent answers from (and cites) the user's chosen pages.
  const turnPinnedKnowledge = knowledge
    ? (await Promise.all((body.knowledgePages ?? []).map((id) => knowledge.getPage(id))))
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
    const manifest = soulLoader?.manifest;
    const business = {
      name: typeof manifest?.businessName === "string" ? manifest.businessName : undefined,
      description:
        typeof manifest?.businessDescription === "string"
          ? manifest.businessDescription
          : undefined,
    };
    return assembleAgentSystemPrompt({
      agent: a,
      platformAgent: pa,
      business,
      memory: memoryList,
      governancePages,
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
    log,
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

  return {
    convo,
    isNew,
    userSwitch,
    agent,
    platformAgent,
    resolved,
    resolvedModelId,
    messages,
    pending,
    buildSystemFor,
  };
}

/**
 * Steps 5–6 of a chat turn: register the stream, run the guardrail input stage, and launch the
 * detached producer over the agent delegation loop. HTTP-free — the SSE route attaches the raw
 * response to `handle.streamId` afterwards; headless callers subscribe to the hub instead.
 */
export async function startChatTurn(
  ctx: ChatTurnContext,
  prepared: PreparedTurn,
  input: TurnInput
): Promise<TurnHandle> {
  const {
    repo,
    messageRepo,
    streamRepo,
    hub,
    soulLoader,
    events,
    toolRegistry,
    guardrails,
    approvalRegistry,
    pendingInteractions,
    surfaceStore,
    streamControllers,
  } = ctx;
  const { user, body, log } = input;
  const {
    convo,
    isNew,
    userSwitch,
    agent,
    platformAgent,
    resolved,
    resolvedModelId,
    pending,
    buildSystemFor,
  } = prepared;
  const { messages } = prepared;

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
  hub.register(streamId);
  // Shared per-turn emitter: the producer loop AND the approval gate emit through it, so
  // out-of-band approval events stay on one monotonic, serialized seq (see stream-emitter.ts).
  const emitter = makeStreamEmitter(streamId, { repo: streamRepo, hub, log });

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
      // Pending interaction stays open — the user can re-submit the answer. The producer never
      // launches; subscribers see the buffered guardrail_block + finish on attach/replay.
      return {
        streamId,
        replyMessageId,
        conversationId: convo._id,
        agentName: agent.name,
        isNew,
        done: Promise.resolve(),
      };
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
  // continues in the same SSE stream.
  // Each agent gets its own streamText tool loop; we suppress the per-agent `finish` part and
  // emit exactly one synthetic finish after the chain ends.
  const MAX_HANDOFF_DEPTH = 4;
  async function* agentTurnStream(): AsyncGenerator<unknown> {
    let activeAgent = agent;
    let activePlatform = platformAgent;
    let turnMessages = messages;

    // Observability accumulators (best-effort, off the critical path). Each finished step emits an
    // LLM_STEP_FINISHED; totals roll up across steps + handoffs into one TURN_FINISHED at the end.
    const turnStart = Date.now();
    let lastStepAt = turnStart;
    let turnSteps = 0;
    let turnTokensIn = 0;
    let turnTokensOut = 0;
    // Idempotent: the first call wins. A `finally` (below) emits "aborted" for stop/throw paths that
    // never reach a normal exit, so the turn always closes out and no trace spans leak.
    let turnFinishedEmitted = false;
    const emitTurnFinished = (status: string): void => {
      if (turnFinishedEmitted) return;
      turnFinishedEmitted = true;
      events?.emit(DOMAIN_EVENTS.TURN_FINISHED, {
        conversationId: convo._id,
        agentId: activeAgent.name,
        status,
        steps: turnSteps,
        tokensIn: turnTokensIn,
        tokensOut: turnTokensOut,
        model: resolvedModelId,
        tier: resolved.tier,
        durationMs: Date.now() - turnStart,
      });
    };

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

    // The `finally` guarantees a TURN_FINISHED on every exit — including stop-aborts (consumer calls
    // generator.return() at a `yield`) and unexpected throws — so observability always closes the
    // turn out and no buffered trace spans leak. emitTurnFinished is idempotent (first status wins).
    try {
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
          model: resolved.model,
          messages: turnMessages,
          // AI SDK v7 rejects `role: "system"` entries in `messages` by default; the per-turn prompt
          // is assembled as a leading system message (and re-seeded on handoff), so opt back in.
          allowSystemInMessages: true,
          tools: turnTools,
          // The stop endpoint aborts this signal to halt generation mid-turn (see streamControllers).
          abortSignal: abortController.signal,
          // Stop the agent's own loop at the step budget, or as soon as it hands off —
          // so control returns to this loop without the agent rambling after the control tool.
          stopWhen: ({ steps }) => {
            if (steps.length >= MAX_TOOL_STEPS) return true;
            const last = steps[steps.length - 1];
            return (last?.toolCalls ?? []).some(
              (c) =>
                c.toolName === "transfer_to_agent" ||
                c.toolName === "ask_user" || // HITL: end the turn cleanly with the form rendered
                c.toolName === "cite_sources" // terminal: cite_sources is the answer's last act —
              // stopping here prevents the model running another step that restates the whole answer
            );
          },
          onError: ({ error }) => {
            log.error({ err: error, conversationId: convo._id }, "chat stream error");
          },
          // Persist each finished step (text and/or tool-call + tool-result) so the durable history
          // captures the whole tool loop across every agent in the chain. `activeAgent.name` is the
          // agent that produced THIS step (it changes across handoffs), recorded as provenance.
          onStepFinish: (step) => {
            // Observability (best-effort, sync emit onto the in-process bus — never blocks the step).
            // Read usage/response off the real step (PersistableStep omits them) and attribute the
            // served model against the resolved chain so fallback turns record the real model.
            const observableStep = step as unknown as ObservableStep;
            const usage = extractStepUsage(observableStep);
            const { model, provider, fellBack, entry } = attributeModel(
              usage.servedModelId,
              resolved.chain,
              resolvedModelId
            );
            const now = Date.now();
            turnSteps += 1;
            turnTokensIn += usage.tokensIn;
            turnTokensOut += usage.tokensOut;
            events?.emit(DOMAIN_EVENTS.LLM_STEP_FINISHED, {
              conversationId: convo._id,
              agentId: activeAgent.name,
              model,
              provider,
              tier: resolved.tier,
              tokensIn: usage.tokensIn,
              tokensOut: usage.tokensOut,
              durationMs: now - lastStepAt,
              // A step served by a non-primary provider means the chain fell back (reliability signal).
              status: fellBack ? "fallback" : "ok",
              // Authoritative per-token cost from the served model's pinned soul spec (if resolved).
              costInPerToken: entry?.spec?.input_cost_per_token,
              costOutPerToken: entry?.spec?.output_cost_per_token,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              reasoning: usage.reasoning,
              tools: extractToolCalls(observableStep),
              // In-memory already; the subscriber persists it only when content capture is enabled.
              completionText: observableStep.text,
            });
            lastStepAt = now;
            return persistStep(
              messageRepo,
              convo._id,
              step as unknown as PersistableStep,
              (e) => log.error({ err: e, conversationId: convo._id }, "persist failed"),
              replyIdHolder,
              { model: resolvedModelId, agentId: activeAgent.name }
            );
          },
        });

        let control: { type: "transfer"; target: string; reason?: string } | undefined;
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
          if (p.type === "tool-result" && p.toolName === "transfer_to_agent") {
            const full = fullResultCache.get(p.toolCallId as string);
            if (full?.success) {
              const data = full.data as Record<string, unknown>;
              control = {
                type: "transfer",
                target: String(data.agentId),
                reason: data.message ? String(data.message) : undefined,
              };
            }
          }
          yield part;
        }

        if (errored) {
          emitTurnFinished("error");
          return; // a terminal `error` was already yielded by the producer
        }
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
          // A HITL pause is not a completed turn — record it as 'paused' so it isn't counted as a
          // success (the resumed continuation emits its own TURN_FINISHED). Idempotent: wins over the
          // "ok" below.
          emitTurnFinished("paused");
          break;
        }
        const transferTarget =
          control?.type === "transfer" ? getAgent(soulLoader, control.target) : undefined;
        if (control?.type === "transfer" && transferTarget && depth < MAX_HANDOFF_DEPTH - 1) {
          const fromAgent = activeAgent.name;
          await repo.setAgent(convo._id, transferTarget.name);
          activeAgent = transferTarget;
          activePlatform = getDefaultAssistant(activeAgent.name);
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
        break;
      }

      // A completed turn feeds the knowledge AgentConversationSource (AC-V1-002).
      events?.emit(DOMAIN_EVENTS.CONVERSATION_COMPLETED, {
        conversationId: convo._id,
        actorId: user._id,
      });
      emitTurnFinished("ok");
      yield { type: "finish", finishReason: "stop" };
    } finally {
      // No-op when a normal/errored exit already emitted; fires only for stop-aborts and throws.
      emitTurnFinished("aborted");
    }
  }

  // Start the detached producer over the loop; callers attach/subscribe via the handle.
  const done = runChatStream(streamId, agentTurnStream(), {
    emitter,
    hub,
    log,
    fullResultCache,
    scanOutput,
    surfaceStore,
    conversationId: convo._id,
    abortSignal: abortController.signal,
  }).finally(() => streamControllers.delete(streamId));

  return {
    streamId,
    replyMessageId,
    conversationId: convo._id,
    agentName: agent.name,
    isNew,
    done,
  };
}

/**
 * Run one chat turn (streamed, AI SDK data-stream protocol) over HTTP. Thin wrapper: prepare the
 * turn (mapping early failures to status codes), write the SSE headers, hijack the reply, launch
 * the detached producer, and attach this connection to the stream (live from seq 0) — so the turn
 * finishes (and keeps buffering) even after the client disconnects.
 */
export async function runChatTurn(req: FastifyRequest, reply: FastifyReply, ctx: ChatTurnContext) {
  const input: TurnInput = {
    user: req.user as UserDoc,
    body: req.body as ChatBody,
    log: req.log,
  };
  const prepared = await prepareChatTurn(ctx, input);
  if (isPrepareError(prepared)) {
    return reply.code(prepared.status).send({ error: prepared.error });
  }
  const handle = await startChatTurn(ctx, prepared, input);
  if (handle.isNew) reply.raw.setHeader("X-Conversation-Id", handle.conversationId);
  writeSseHeaders(reply.raw, {
    "X-Stream-Id": handle.streamId,
    "X-Message-Id": handle.replyMessageId,
    // Only a user-selected Soul Agent is exposed to the client. Normal chat has no agent identity —
    // and a removed agent resolves back to normal chat, so key off the resolved agent, not the
    // (possibly stale) persisted convo.agentId.
    ...(prepared.agent.name !== DEFAULT_ASSISTANT_NAME ? { "X-Agent-Id": handle.agentName } : {}),
    ...corsPassthrough(reply),
  });
  reply.hijack();
  void attachToStream(reply.raw, handle.streamId, 0, { repo: ctx.streamRepo, hub: ctx.hub });
}
