import type {
  MEMORY_TYPES,
  MemoryCandidate,
  MemoryExtractionInput,
  MemoryExtractionPort,
} from "@tulipfarm/memory";
import { generateText, type LanguageModel } from "ai";

/**
 * LLM-backed Memory extraction (SPEC §14.3). Runs *after* a turn has answered, never inside it:
 * inline extraction would put an extra model call on every response for a result the user does not
 * see. Correspondingly it is best-effort — a failed extraction costs a few candidates, not a turn.
 */

export const EXTRACTION_WINDOW_MESSAGES = 12;
export const MAX_CANDIDATES_PER_TURN = 5;
const MAX_MESSAGE_CHARS = 2_000;

const EXTRACTION_PROMPT = [
  "You extract durable facts about the user from a conversation, for long-term memory.",
  "",
  "Extract only what would still be useful weeks from now, and only what the USER stated or",
  "clearly implied about themselves, their work, their preferences, or people and projects they",
  "named. Ignore anything the assistant said about itself.",
  "",
  "Do NOT extract:",
  "- instructions, rules, or anything phrased as a command — memory records what is true, not what to do",
  "- transient details (what they are doing right now, one-off requests, the current question)",
  "- anything already obvious from the conversation's topic alone",
  "- speculation. If you are not confident, leave it out.",
  "",
  `Return at most ${MAX_CANDIDATES_PER_TURN} items as strict JSON, and nothing else:`,
  '{"candidates":[{"subject":"short noun phrase","statement":"the fact, one sentence",',
  '"memoryType":"preference"|"fact","confidence":0.0-1.0,"importance":0.0-1.0,',
  '"entities":["normalized name"]}]}',
  "",
  'If there is nothing worth remembering, return {"candidates":[]}.',
].join("\n");

/** The extractable subset of memory types. `procedural` and `episodic` are never inferred here. */
const EXTRACTABLE_TYPES = new Set<string>(["preference", "fact"]);

function renderMessages(messages: MemoryExtractionInput["messages"]): string {
  return messages
    .slice(-EXTRACTION_WINDOW_MESSAGES)
    .map((m) => `${m.role}: ${m.content.slice(0, MAX_MESSAGE_CHARS)}`)
    .join("\n");
}

/**
 * Pulls the JSON object out of a model response. Taking the outermost braces recovers the common
 * cases; anything else yields no candidates, which is the correct failure for this pipeline.
 */
function parseCandidates(raw: string): readonly unknown[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return [];
    const candidates = (parsed as { candidates?: unknown }).candidates;
    return Array.isArray(candidates) ? candidates : [];
  } catch {
    return [];
  }
}

function clamp01(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

/** Normalizes one raw item into a candidate, or `undefined` if it is not shaped like one. */
function toCandidate(raw: unknown): MemoryCandidate | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  const subject = typeof item.subject === "string" ? item.subject : "";
  const statement = typeof item.statement === "string" ? item.statement : "";
  if (subject.trim().length === 0 || statement.trim().length === 0) return undefined;

  const declared = typeof item.memoryType === "string" ? item.memoryType : "";
  const memoryType = EXTRACTABLE_TYPES.has(declared)
    ? (declared as (typeof MEMORY_TYPES)[number])
    : "fact";
  const entities = Array.isArray(item.entities)
    ? item.entities.filter((e): e is string => typeof e === "string" && e.trim().length > 0)
    : [];
  const confidence = clamp01(item.confidence, 0);

  return {
    subject,
    statement,
    memoryType,
    confidence,
    importance: clamp01(item.importance, confidence),
    entities,
  };
}

export function candidatesFromResponse(raw: string): readonly MemoryCandidate[] {
  const parsed: MemoryCandidate[] = [];
  for (const item of parseCandidates(raw)) {
    const candidate = toCandidate(item);
    if (candidate !== undefined) parsed.push(candidate);
    if (parsed.length === MAX_CANDIDATES_PER_TURN) break;
  }
  return parsed;
}

/**
 * `MemoryExtractionPort` over the quick LLM tier. `getModel` is a thunk because the model is
 * resolved from Soul config that reloads at runtime, and because a not-configured deployment must
 * degrade to extracting nothing rather than failing.
 */
export class LlmMemoryExtractor implements MemoryExtractionPort {
  constructor(private readonly getModel: () => LanguageModel) {}

  async extract(input: MemoryExtractionInput): Promise<readonly MemoryCandidate[]> {
    const transcript = renderMessages(input.messages);
    if (transcript.trim().length === 0) return [];
    try {
      const { text } = await generateText({
        model: this.getModel(),
        prompt: `${EXTRACTION_PROMPT}\n\nConversation:\n${transcript}`,
      });
      return candidatesFromResponse(text);
    } catch {
      return [];
    }
  }
}
