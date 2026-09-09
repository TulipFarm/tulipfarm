import {
  ajv,
  isMemorySectionKey,
  MEMORY_SECTION_KEYS,
  MEMORY_SECTION_PURPOSE,
  type MemorySectionKey,
} from "@tulipfarm/schema";
import { type ApiToolDefinition, defineApiTool } from "@tulipfarm/tool-host";
import { err, ok } from "../tool-result";
import { MemoryWriteRejected } from "./document";
import { timezoneFromMemoryDocument } from "./sections";
import type { MemoryDocumentRepo } from "./store";

/** Per-turn context for the Memory Document Tool. */
export interface MemoryDocumentToolContext {
  readonly businessId: string;
  readonly userId: string;
  readonly documents: MemoryDocumentRepo;
  /**
   * The user's explicit standing instructions, if the host stores any.
   *
   * They ride along with `get_memory` because they answer the same question the Agent is asking —
   * "what does this person durably expect of me?" — and splitting them across two Tools means an
   * Agent that calls one and not the other silently ignores half the answer.
   */
  readonly customInstructions?: () => Promise<string | undefined>;
  readonly agentId?: string;
  readonly runId?: string;
  readonly now?: () => Date;
}

const SECTION_GUIDE = MEMORY_SECTION_KEYS.map(
  (key) => `- ${key}: ${MEMORY_SECTION_PURPOSE[key]}`
).join("\n");

const ENTRY_LIST = {
  type: "array",
  minItems: 1,
  maxItems: 20,
  items: { type: "string", minLength: 1, maxLength: 500 },
} as const;

const UPDATE_MEMORY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["section"],
  properties: {
    section: {
      type: "string",
      enum: [...MEMORY_SECTION_KEYS],
      description: "Which section of the memory document to edit.",
    },
    add: {
      ...ENTRY_LIST,
      description:
        "Facts to record. One self-contained fact per string, written as a statement about the " +
        "user. No Markdown headings.",
    },
    remove: {
      ...ENTRY_LIST,
      description:
        "Facts to forget. Each string must match an existing line in the section verbatim. " +
        "Anything you do not name is left alone.",
    },
  },
};

const validate = ajv.compile(UPDATE_MEMORY_SCHEMA);

function firstError(errors: typeof validate.errors): string {
  const detail = errors?.[0];
  if (!detail) return "invalid arguments";
  return `${detail.instancePath || "(root)"} ${detail.message ?? "is invalid"}`.trim();
}

function memorySectionTarget(args: unknown) {
  const source = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const section = source.section;
  return typeof section === "string" && isMemorySectionKey(section)
    ? [{ type: "platform.memory", id: `section:${section}` }]
    : [];
}

/**
 * The one durable-memory write path.
 *
 * Its description has to actively ask the model to write: a Tool the model is never told to reach
 * for is a Tool that records nothing, which is exactly how the engine this replaces came to save
 * almost nothing on its own.
 *
 * It offers no whole-section overwrite. The model can only name the entries it adds and the
 * entries it removes, so a concurrent write it never saw cannot be destroyed — the reason this
 * Tool needs no version, hash, or conflict handling.
 */
export const updateMemoryTool = defineApiTool<MemoryDocumentToolContext>({
  name: "update_memory",
  description: `Edit the user's durable memory document, carried across every future conversation with this user.

Call this whenever you learn something durable about the user, without being asked and without asking permission first: who they are, where they work, what they are responsible for, how they want you to reply, a standing rule they just gave you, or a decision they just made. If you would want to know it next week, write it now. Also call it when the user says "remember ...", and when something already recorded turns out to be wrong.

Do not record: anything that stops being true within the hour, anything you inferred rather than observed, secrets, or long documents — those belong in create_knowledge_page.

Sections:
${SECTION_GUIDE}

Use \`add\` for new facts and \`remove\` for facts that are no longer true. To correct a fact, pass both in one call. \`remove\` only drops the exact lines you name, and it matches verbatim, so it can only remove a line you have seen; everything you do not name is left untouched.`,
  tier: "platform",
  mutating: true,
  inputSchema: UPDATE_MEMORY_SCHEMA,
  authorization: {
    action: "memory.document.write",
    resources: ["platform.memory"],
    targets: memorySectionTarget,
    dataClasses: ["memory"],
  },
  handler: async (args, ctx) => {
    if (!validate(args)) return err("validation_error", firstError(validate.errors));
    const { section, add, remove } = args as {
      section: MemorySectionKey;
      add?: string[];
      remove?: string[];
    };

    try {
      const outcome = await ctx.documents.applyDelta({
        businessId: ctx.businessId,
        userId: ctx.userId,
        delta: {
          section,
          ...(add === undefined ? {} : { add }),
          ...(remove === undefined ? {} : { remove }),
        },
        writer: "tool",
        ...(ctx.runId === undefined ? {} : { writerRunId: ctx.runId }),
        now: ctx.now?.() ?? new Date(),
      });

      // `unmatched` is reported, never hidden: exact matching can miss a paraphrase, so a model
      // told only "success" would tell the user it had forgotten something still on file.
      return ok({
        section,
        added: outcome.added.length,
        removed: outcome.removed.length,
        ...(outcome.unmatched.length === 0
          ? {}
          : {
              unmatched: outcome.unmatched,
              note: "These were not found in the section and are still unrecorded or worded differently. Do not tell the user they were forgotten.",
            }),
      });
    } catch (cause) {
      if (cause instanceof MemoryWriteRejected) return err("validation_error", cause.message);
      throw cause;
    }
  },
});

const GET_MEMORY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

const validateGetMemory = ajv.compile(GET_MEMORY_SCHEMA);

/**
 * The fallback read path. In a healthy Turn nothing should call it.
 *
 * The Soul reminder carries the whole document in `<user-memory>`, re-rendered from the store on
 * every Turn, so an Agent has already been handed everything this returns and cannot hold a stale
 * copy. Two cases are left over, and both are the reminder failing rather than the Agent needing
 * more: a Turn that renders no reminder (no authority-layer resolver composed), and a reminder
 * dropped by the context budget — it sits at `skill_instructions`, which is compactable.
 *
 * The description therefore has to argue *against* itself. A read Tool that merely says what it
 * returns gets called on reflex, and that reflex is what this Tool used to buy on every single
 * conversation.
 */
export const getMemoryTool = defineApiTool<MemoryDocumentToolContext>({
  name: "get_memory",
  description: `Fallback read of this user's durable memory document. You will almost never need it.

You already have the document. The <user-memory> block in the system reminder carries it in full, and <custom-instructions> carries the user's own standing instructions. Both are rebuilt from storage on every single turn, so what you can see is current — it cannot go stale mid-conversation, however long the conversation runs, and calling this returns exactly the text you already have.

So do not call this to open a conversation, to look up a preference or a standing rule, to check whether anything is recorded about the user, or to re-read a line before removing it. Read the block instead.

Call it only if <user-memory> is missing from your context entirely. That means the reminder failed to render, and this is the only way to recover what it would have told you.

Returns the document as Markdown in \`document\`, plus any standing instructions in \`customInstructions\` — those are the user's own words and outrank your <agent-personality>. If \`timezone\` comes back, pass it to \`get_current_time\`; the clock defaults to UTC and will otherwise date things in the wrong day for this user.`,
  tier: "platform",
  mutating: false,
  inputSchema: GET_MEMORY_SCHEMA,
  authorization: {
    action: "memory.document.read",
    resources: ["platform.memory"],
    dataClasses: ["memory"],
  },
  handler: async (args, ctx) => {
    if (!validateGetMemory(args))
      return err("validation_error", firstError(validateGetMemory.errors));
    const [document, instructions] = await Promise.all([
      ctx.documents.render(ctx.businessId, ctx.userId),
      ctx.customInstructions?.() ?? Promise.resolve(undefined),
    ]);
    const recalled = document.trim();
    const standing = instructions?.trim();
    if (recalled.length === 0 && (standing === undefined || standing.length === 0)) {
      return ok({
        document: "",
        empty: true,
        note: "Nothing durable is recorded about this user yet.",
      });
    }
    const timezone = timezoneFromMemoryDocument(recalled);
    return ok({
      document: recalled,
      ...(standing === undefined || standing.length === 0 ? {} : { customInstructions: standing }),
      ...(timezone === undefined ? {} : { timezone }),
      empty: false,
    });
  },
});

export const MEMORY_DOCUMENT_TOOLS: ApiToolDefinition<MemoryDocumentToolContext>[] = [
  getMemoryTool,
  updateMemoryTool,
];
