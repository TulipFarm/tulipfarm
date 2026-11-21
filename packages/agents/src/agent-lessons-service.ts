import { AccessDenied, type HumanActor } from '@tulipfarm/access';
import {
  agentLessonEditSchema,
  agentLessonLimits,
  type agentLessonErrorCodes,
  type AgentLessonsView,
} from './agent-lesson-contracts.ts';
import {
  AgentLessonsUnavailable,
  agentLessonsStore,
  cleanLessonText,
  lessonLeak,
  type AgentLessonBook,
} from './agent-lessons.ts';
import { requireAgentPermission, withHuman } from './saved-policy.ts';
import type { AgentStorage } from './store.ts';

export * from './agent-lesson-contracts.ts';

export class AgentLessonError extends Error {
  readonly status: number;
  readonly code: (typeof agentLessonErrorCodes)[number];
  constructor(code: (typeof agentLessonErrorCodes)[number]) {
    super(code);
    this.code = code;
    this.name = 'AgentLessonError';
    this.status = code === 'not-found' ? 404 : code === 'lesson-private' ? 422 : 503;
  }
}

/** The view of a book, without the source run of each lesson: that run may belong to another member. */
function view(book: AgentLessonBook): AgentLessonsView {
  return {
    lessons: book.lessons.map(({ id, kind, text, at }) => ({ id, kind, text, confirmedAt: at })),
    suggestions: book.suggestions.map(({ id, area, text, at }) => ({ id, area, text, suggestedAt: at })),
    limits: { lessons: agentLessonLimits.lessons, lessonCharacters: agentLessonLimits.lessonCharacters },
  };
}

/** The Lessons tab: people who can edit a saved agent read, edit and delete what it learned, and dismiss suggestions. */
export function createAgentLessons(runtime: AgentStorage) {
  async function editable(workspaceId: string, user: string | HumanActor, agentId: string) {
    try {
      await withHuman(runtime, workspaceId, user, 'read', (tx, actor) =>
        requireAgentPermission(tx, actor, agentId, 'edit'),
      );
    } catch (error) {
      if (error instanceof AccessDenied) throw new AgentLessonError('not-found');
      throw error;
    }
    return agentLessonsStore(workspaceId, agentId);
  }
  async function keep<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AgentLessonsUnavailable) throw new AgentLessonError('lessons-unavailable');
      throw error;
    }
  }
  const change = (
    workspaceId: string,
    user: string | HumanActor,
    agentId: string,
    update: (book: AgentLessonBook) => AgentLessonBook,
  ) => keep(async () => view(await (await editable(workspaceId, user, agentId)).update(update)));

  return {
    read: (workspaceId: string, user: string | HumanActor, agentId: string) =>
      keep(async () => view(await (await editable(workspaceId, user, agentId)).read())),
    /** Replaces a lesson's text. Edited text gets the same privacy check as learned text. */
    async edit(workspaceId: string, user: string | HumanActor, agentId: string, lessonId: string, input: unknown) {
      const text = cleanLessonText(agentLessonEditSchema.parse(input).text);
      if (lessonLeak(text)) throw new AgentLessonError('lesson-private');
      let found = false;
      const result = await change(workspaceId, user, agentId, book => {
        found = book.lessons.some(lesson => lesson.id === lessonId);
        return {
          ...book,
          lessons: book.lessons.map(lesson =>
            lesson.id === lessonId ? { ...lesson, text, at: new Date().toISOString() } : lesson,
          ),
        };
      });
      if (!found) throw new AgentLessonError('not-found');
      return result;
    },
    remove: (workspaceId: string, user: string | HumanActor, agentId: string, lessonId: string) =>
      change(workspaceId, user, agentId, book => ({
        ...book,
        lessons: book.lessons.filter(lesson => lesson.id !== lessonId),
      })),
    clear: (workspaceId: string, user: string | HumanActor, agentId: string) =>
      change(workspaceId, user, agentId, book => ({ ...book, lessons: [] })),
    dismiss: (workspaceId: string, user: string | HumanActor, agentId: string, suggestionId: string) =>
      change(workspaceId, user, agentId, book => ({
        ...book,
        suggestions: book.suggestions.filter(suggestion => suggestion.id !== suggestionId),
      })),
  };
}
export type AgentLessons = ReturnType<typeof createAgentLessons>;
