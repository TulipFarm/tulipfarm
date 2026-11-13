import { z } from 'zod';
import {
  appDefinitionLimits,
  checkAppDefinition,
  type AppDefinitionIssue,
  type AppFailure,
  type AppId,
  type MembershipId,
} from '@tulipfarm/apps';
import {
  appRole,
  discardDraftChanges,
  missingAppReferences,
  readApp,
  readDraft,
  readDraftDefinition,
  writeDraftDefinition,
  type AppTransaction,
} from '@tulipfarm/apps/store';
import { chatApp, type AppChat } from './app-tools.ts';
import { withHuman } from './saved-policy.ts';
import type { AgentStorage, AgentTransaction } from './store.ts';

const pageId = z.string().min(1).max(48);

export const appPageToolCallSchemas = [
  z.strictObject({
    tool: z.literal('apps.page.read'),
    page: pageId.optional().describe('ID of one page to read. Leave it out to read every page.'),
  }),
  z.strictObject({
    tool: z.literal('apps.page.replace'),
    page: z
      .looseObject({
        id: pageId.describe('Page ID. A page with this ID is replaced; a new ID adds a page at the end.'),
      })
      .describe(
        'The whole page: id, slug, title, optional row { tableId }, sources, actions, and surface (createSurface then updateComponents messages for catalog tulipfarm/apps@1).',
      ),
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .describe('The revision apps.page.read or the last apps.page.replace returned.'),
  }),
  z.strictObject({ tool: z.literal('apps.page.check') }),
] as const;
const appPageToolCallSchema = z.discriminatedUnion('tool', appPageToolCallSchemas);
export type AppPageToolCall = z.infer<typeof appPageToolCallSchema>;
export type AppPageToolName = AppPageToolCall['tool'];

export const appPageToolDescriptions: Record<AppPageToolName, string> = {
  'apps.page.read':
    'Read the draft pages of the private app this chat edits, with the draft revision. The live app is unchanged until the editor publishes. Changes nothing.',
  'apps.page.replace': `Replace one page of the private app this chat edits, or add it when its ID is new, in the draft only. Pass the revision you last read; stale-draft means the draft changed, so read it again first. Returns the new revision and every issue the draft still has, by JSON path. An app holds at most ${appDefinitionLimits.pages} pages. Only one chat edits an app at a time; draft-busy means another chat holds it. Only the editor publishes.`,
  'apps.page.check':
    'Check the draft pages of the private app this chat edits, including that every table, field, file, workflow and agent they name still exists. Returns each issue with its JSON path, such as /pages/0/actions/1/pageId. Changes nothing.',
};

export type AppPageOptions = {
  /** Whether the workspace has app hosting turned on. */
  readonly enabled: (workspaceId: string) => Promise<boolean>;
};

type Failure = { readonly error: AppFailure['code']; readonly message: string; readonly retryable: boolean };
const failure = ({ code, message, retryable }: AppFailure): Failure => ({ error: code, message, retryable });

type DraftPage = { readonly id: string } & Record<string, unknown>;
const draftPagesSchema = z.object({ pages: z.array(z.looseObject({ id: z.string() })) });

/** The pages as last written. Only `apps.page.replace` writes them, always as `{ pages }` with an ID on each. */
const draftPages = (definition: unknown): DraftPage[] => draftPagesSchema.safeParse(definition).data?.pages ?? [];

const withPage = (pages: readonly DraftPage[], page: DraftPage) =>
  pages.some(({ id }) => id === page.id) ? pages.map(item => (item.id === page.id ? page : item)) : [...pages, page];

/**
 * The page tools of a private app's own chat. Every call checks again that app hosting is on, that the chat edits a
 * private app and that the person still holds `edit` on it, so a revoked grant stops the next call.
 */
export function createAppPages(runtime: AgentStorage, options: AppPageOptions) {
  async function withApp<T>(
    chat: AppChat,
    action: (tx: AppTransaction, appId: AppId) => Promise<T>,
  ): Promise<T | Failure> {
    if (!(await options.enabled(chat.workspaceId)))
      return failure({ code: 'forbidden', message: 'App hosting is off in this workspace', retryable: false });
    return withHuman(runtime, chat.workspaceId, chat.actor, 'read', async (raw: AgentTransaction) => {
      const tx = { client: raw.client, schema: raw.schema };
      const appId = await chatApp(tx, chat.conversationId);
      const app = appId && (await readApp(tx, appId));
      if (
        !app ||
        app.kind !== 'private' ||
        app.archivedAt !== null ||
        (await appRole(tx, app.id, chat.actor.membershipId as MembershipId)) !== 'edit'
      )
        return failure({ code: 'forbidden', message: 'This chat cannot edit app pages', retryable: false });
      return action(tx, app.id);
    });
  }

  async function issues(tx: AppTransaction, definition: unknown): Promise<AppDefinitionIssue[]> {
    const checked = checkAppDefinition(definition ?? { pages: [] });
    return checked.ok ? missingAppReferences(tx, checked.definition) : checked.issues;
  }

  const read = (chat: AppChat, page: string | undefined) =>
    withApp(chat, async (tx, appId) => {
      const draft = (await readDraftDefinition(tx, appId))!;
      const pages = draftPages(draft.definition);
      if (page === undefined) return { revision: draft.revision, pages };
      const found = pages.find(({ id }) => id === page);
      return found
        ? { revision: draft.revision, page: found }
        : failure({ code: 'not-found', message: `No page has ID ${page}`, retryable: false });
    });

  const replace = (chat: AppChat, page: DraftPage, expectedRevision: number) =>
    withApp(chat, async (tx, appId) => {
      const definition = { pages: withPage(draftPages((await readDraftDefinition(tx, appId))!.definition), page) };
      const written = await writeDraftDefinition(tx, {
        appId,
        conversationId: chat.conversationId,
        membershipId: chat.actor.membershipId as MembershipId,
        expectedRevision,
        definition,
      });
      if (!written.ok) return failure(written.failure);
      return { revision: written.revision, issues: await issues(tx, definition) };
    });

  const check = (chat: AppChat) =>
    withApp(chat, async (tx, appId) => {
      const draft = (await readDraftDefinition(tx, appId))!;
      const found = await issues(tx, draft.definition);
      return { revision: draft.revision, ok: found.length === 0, issues: found };
    });

  return {
    /** Whether this chat is offered the page tools. The worker asks once per turn; each call checks again. */
    async admitted(chat: AppChat) {
      return !('error' in (await withApp(chat, async () => ({ admitted: true }))));
    },

    invoke(chat: AppChat, call: AppPageToolCall): Promise<unknown> {
      switch (call.tool) {
        case 'apps.page.read':
          return read(chat, call.page);
        case 'apps.page.replace':
          return replace(chat, call.page, call.expectedRevision);
        case 'apps.page.check':
          return check(chat);
      }
    },

    /** Frees this chat's hold on the draft once its turn settles. Replaced pages are already in the draft. */
    async finishTurn(chat: AppChat) {
      await withHuman(runtime, chat.workspaceId, chat.actor, 'read', async raw => {
        const tx = { client: raw.client, schema: raw.schema };
        const appId = await chatApp(tx, chat.conversationId);
        const lease = appId && (await readDraft(tx, appId))?.lease;
        if (appId && lease?.conversationId === chat.conversationId) await discardDraftChanges(tx, appId, lease.id);
      });
    },
  };
}
export type AppPages = ReturnType<typeof createAppPages>;
