import { createHash } from 'node:crypto';
import { z } from 'zod';
import { keepConfiguration } from '@tulipfarm/config/keep';
import {
  createKeepClient,
  keepAgentScope,
  keepLessonsPath,
  type KeepClient,
  type KeepMemoryResult,
} from '@tulipfarm/memory-keep';
import { log } from '@tulipfarm/observability';

import {
  agentLessonLimits,
  lessonKinds,
  suggestionAreas,
  type LessonKind,
  type SuggestionArea,
} from './agent-lesson-contracts.ts';

export { agentLessonLimits, lessonKinds, suggestionAreas, type LessonKind, type SuggestionArea };

const isoSchema = z.string().max(40);
const runIdSchema = z.uuid();
const lessonSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{8,16}$/),
  kind: z.enum(lessonKinds),
  text: z.string().min(1).max(agentLessonLimits.lessonCharacters),
  run: runIdSchema.nullable(),
  at: isoSchema,
});
const suggestionSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{8,16}$/),
  area: z.enum(suggestionAreas),
  text: z.string().min(1).max(agentLessonLimits.suggestionCharacters),
  run: runIdSchema.nullable(),
  at: isoSchema,
});
export type AgentLesson = z.infer<typeof lessonSchema>;
export type AgentSuggestion = z.infer<typeof suggestionSchema>;
export type AgentLessonBook = { lessons: AgentLesson[]; suggestions: AgentSuggestion[] };

const header = '# Lessons learned from earlier runs';
const metaPattern = /^<!-- (lesson|suggestion) (\{.*\}) -->$/;

/** Collapses whitespace so a lesson stays one line, and drops leading `#` so it never reads as a new section. */
export function cleanLessonText(value: string) {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+\s*/, '');
}

/** Renders the book as one Keep file: a Markdown section per entry with its metadata in an HTML comment. */
export function renderLessonBook(book: AgentLessonBook) {
  const entry = (type: 'lesson' | 'suggestion', item: AgentLesson | AgentSuggestion) => {
    const { text, id, ...meta } = item;
    return `## ${id}\n<!-- ${type} ${JSON.stringify(meta)} -->\n${cleanLessonText(text)}\n`;
  };
  return [
    header,
    '',
    ...book.lessons.map(item => entry('lesson', item)),
    ...book.suggestions.map(item => entry('suggestion', item)),
  ].join('\n');
}

/** Reads the Keep file back. Sections that do not parse, such as a hand edit in Keep, are skipped rather than trusted. */
export function parseLessonBook(text: string): AgentLessonBook {
  const book: AgentLessonBook = { lessons: [], suggestions: [] };
  for (const section of text.split(/^## /m).slice(1)) {
    const [idLine = '', metaLine = '', ...body] = section.split('\n');
    const match = metaPattern.exec(metaLine.trim());
    if (!match) continue;
    let meta: unknown;
    try {
      meta = JSON.parse(match[2]!);
    } catch {
      continue;
    }
    const candidate = { ...(meta as object), id: idLine.trim(), text: cleanLessonText(body.join(' ')) };
    if (match[1] === 'lesson') {
      const parsed = lessonSchema.safeParse(candidate);
      if (parsed.success) book.lessons.push(parsed.data);
    } else {
      const parsed = suggestionSchema.safeParse(candidate);
      if (parsed.success) book.suggestions.push(parsed.data);
    }
  }
  return book;
}

const words = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const normalized = (value: string) => words(value).join(' ');

/** Two lessons are the same when their words match, or when at least 80% of their distinct words overlap. */
export function sameLesson(a: string, b: string) {
  if (normalized(a) === normalized(b)) return true;
  const left = new Set(words(a)),
    right = new Set(words(b));
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared) >= 0.8;
}

export function lessonId(text: string, salt = '') {
  return BigInt(
    `0x${createHash('sha256')
      .update(`${normalized(text)}\u0000${salt}`)
      .digest('hex')
      .slice(0, 15)}`,
  )
    .toString(36)
    .padStart(12, '0')
    .slice(-12);
}

const newestFirst = <T extends { at: string }>(items: readonly T[]) =>
  [...items].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

/**
 * Adds new lessons and suggestions to a book. A repeat of an existing entry refreshes it instead of adding it; past the
 * caps, the least recently confirmed entries go first, and so on until the file fits Keep's size limit.
 */
export function mergeLessonBook(
  book: AgentLessonBook,
  incoming: {
    lessons?: readonly { kind: LessonKind; text: string }[];
    suggestions?: readonly { area: SuggestionArea; text: string }[];
  },
  source: { run: string | null; at: string },
): AgentLessonBook {
  const lessons = book.lessons.map(item => ({ ...item }));
  for (const item of incoming.lessons ?? []) {
    const text = cleanLessonText(item.text).slice(0, agentLessonLimits.lessonCharacters);
    if (!text) continue;
    const existing = lessons.find(lesson => sameLesson(lesson.text, text));
    if (existing) Object.assign(existing, { run: source.run ?? existing.run, at: source.at });
    else lessons.push({ id: lessonId(text, source.at), kind: item.kind, text, run: source.run, at: source.at });
  }
  const suggestions = book.suggestions.map(item => ({ ...item }));
  for (const item of incoming.suggestions ?? []) {
    const text = cleanLessonText(item.text).slice(0, agentLessonLimits.suggestionCharacters);
    if (!text) continue;
    const existing = suggestions.find(suggestion => sameLesson(suggestion.text, text));
    if (existing) Object.assign(existing, { run: source.run ?? existing.run, at: source.at });
    else
      suggestions.push({ id: lessonId(text, `s${source.at}`), area: item.area, text, run: source.run, at: source.at });
  }
  return fitLessonBook({ lessons, suggestions });
}

/** Applies the caps and Keep's file size limit, keeping the most recently confirmed entries. */
export function fitLessonBook(book: AgentLessonBook): AgentLessonBook {
  const lessons = newestFirst(book.lessons).slice(0, agentLessonLimits.lessons);
  const suggestions = newestFirst(book.suggestions).slice(0, agentLessonLimits.suggestions);
  while (
    Buffer.byteLength(renderLessonBook({ lessons, suggestions })) > agentLessonLimits.fileBytes &&
    (lessons.length || suggestions.length)
  )
    (lessons.length >= suggestions.length ? lessons : suggestions).pop();
  return { lessons, suggestions };
}

/** Lessons for one run, newest first, within the character budget. */
export function lessonsForContext(book: AgentLessonBook) {
  const chosen: { text: string }[] = [];
  let used = 0;
  for (const lesson of newestFirst(book.lessons)) {
    if (used + lesson.text.length > agentLessonLimits.contextCharacters) break;
    used += lesson.text.length;
    chosen.push({ text: lesson.text });
  }
  return chosen;
}

const contactOrIdentifier = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /\bhttps?:\/\//i,
  /\bwww\./i,
  /\b[\w-]+\.(?:com|org|net|io|ai|co|dev|app)\b/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b[0-9a-f]{16,}\b/i,
  /\d[\d\s,.-]{4,}\d/,
  /\+\d{6,}/,
  /["“”«»]|(?:^|\s)'[^']+'/,
];

/** Words common enough in instructions that they identify nobody's data. */
const commonNames = new Set(
  'i ok tulipfarm slack google gmail github jira confluence notion markdown json csv pdf api url mcp ai'.split(' '),
);

/**
 * Names, numbers and other specific words in `text`: words with a digit, and capitalized words inside a sentence. Words
 * are split the way `words` splits them, so a possessive or hyphenated name still matches its plain form.
 */
function distinctiveWords(text: string) {
  const found = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?:;])\s+|\n+/)) {
    const tokens = sentence.match(/[\p{L}\p{N}]+/gu) ?? [];
    tokens.forEach((token, index) => {
      if (/\d/.test(token) || (index > 0 && /^\p{Lu}/u.test(token))) found.add(token.toLowerCase());
    });
  }
  return found;
}

/**
 * Why a lesson may carry data from its run, or null when it is safe to share with everyone who runs the agent. A lesson
 * is general guidance, so it must not contain contact details, links, ids, long numbers or quotes, nor a name or value
 * from the run's private evidence that the agent's own definition does not mention. A word counts as such a name when
 * the evidence or the lesson treats it as one, wherever it sits in the lesson and in whatever case.
 */
export function lessonLeak(text: string, context: { evidence?: readonly string[]; definition?: string } = {}) {
  if (contactOrIdentifier.some(pattern => pattern.test(text))) return 'identifier';
  if (!context.evidence?.length) return null;
  const allowed = new Set(words(context.definition ?? ''));
  const evidenceWords = new Set(context.evidence.flatMap(item => words(item)));
  const evidenceNames = new Set(context.evidence.flatMap(item => [...distinctiveWords(item)]));
  const lessonNames = distinctiveWords(text);
  for (const word of new Set(words(text))) {
    if (commonNames.has(word) || allowed.has(word)) continue;
    if (evidenceNames.has(word) || (lessonNames.has(word) && evidenceWords.has(word))) return 'private-name';
  }
  return null;
}

/** The text a definition makes visible to everyone who can run the agent: its name, instructions, tools and Skills. */
export function definitionVocabulary(definition: {
  name: string;
  instructions?: string | undefined;
  tools?: readonly string[] | undefined;
  skills?: readonly unknown[] | undefined;
}) {
  return [
    definition.name,
    definition.instructions ?? '',
    ...(definition.tools ?? []),
    JSON.stringify(definition.skills ?? []),
  ].join('\n');
}

type Dependencies = { readonly client: () => KeepClient | undefined };

function defaults(): Dependencies {
  let client: KeepClient | undefined | null = null;
  return {
    client() {
      if (client !== null) return client;
      const configuration = keepConfiguration();
      client =
        configuration.status === 'configured'
          ? createKeepClient({ endpoint: configuration.endpoint, token: configuration.token, timeoutMs: 3000 })
          : undefined;
      return client;
    },
  };
}
let dependencies = defaults();

/** Replaces how Keep is reached, for tests and local tools. Returns a function that restores the default. */
export function configureAgentLessons(options: { client?: KeepClient | undefined }) {
  dependencies = { client: 'client' in options ? () => options.client : dependencies.client };
  return () => {
    dependencies = defaults();
  };
}

/** Keep is not configured or did not answer. Lessons are skipped, never treated as empty. */
export class AgentLessonsUnavailable extends Error {
  constructor() {
    super('agent-lessons-unavailable');
    this.name = 'AgentLessonsUnavailable';
  }
}

function failed(result: Exclude<KeepMemoryResult<unknown>, { status: 'ok' }>, operation: string): never {
  // Only the operation and Keep's answer are logged: never lesson text or scope.
  log('warn', 'dependency', 'call_failed', {
    operation: `keep.agent-lessons.${operation}`,
    outcome: result.status,
    ...('code' in result && result.code ? { code: result.code } : {}),
  });
  throw new AgentLessonsUnavailable();
}

/** One agent's lessons in its own Keep scope. */
export function agentLessonsStore(workspaceId: string, agentId: string) {
  const client = dependencies.client();
  const target = { scope: keepAgentScope(workspaceId, agentId), path: keepLessonsPath };
  async function load() {
    if (!client) throw new AgentLessonsUnavailable();
    const file = await client.read(target);
    if (file.status === 'not_found') return { book: { lessons: [], suggestions: [] }, revisionId: undefined };
    if (file.status !== 'ok') failed(file, 'read');
    return { book: parseLessonBook(file.value.text), revisionId: file.value.head.revisionId };
  }
  return {
    async read(): Promise<AgentLessonBook> {
      return (await load()).book;
    },
    /** Changes the book with compare-and-swap, reading it again after a concurrent change. Returns the saved book. */
    async update(change: (book: AgentLessonBook) => AgentLessonBook): Promise<AgentLessonBook> {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await load();
        const next = fitLessonBook(change(current.book));
        const text = renderLessonBook(next);
        if (text === renderLessonBook(current.book)) return next;
        const written = await client!.write({
          ...target,
          text,
          description: 'Lessons this agent learned from earlier runs',
          ...(current.revisionId ? { expectedRevisionId: current.revisionId } : {}),
        });
        if (written.status === 'ok') return next;
        if (written.status !== 'conflict') failed(written, 'write');
      }
      throw new AgentLessonsUnavailable();
    },
  };
}

/** The lessons a task run of the agent receives, or undefined when there are none or Keep cannot answer. */
export async function readAgentLessonsContext(workspaceId: string, agentId: string) {
  if (!dependencies.client()) return undefined;
  try {
    const lessons = lessonsForContext(await agentLessonsStore(workspaceId, agentId).read());
    return lessons.length ? lessons : undefined;
  } catch (error) {
    if (error instanceof AgentLessonsUnavailable) return undefined;
    throw error;
  }
}
