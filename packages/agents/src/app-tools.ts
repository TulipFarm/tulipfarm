import { setTimeout as sleep } from 'node:timers/promises';
import { escapeIdentifier } from 'pg';
import { z } from 'zod';
import type { HumanActor } from '@tulipfarm/access';
import {
  appLimits,
  edgeStatus,
  type AppBuildId,
  type AppFailure,
  type AppId,
  type GitCommit,
  type MembershipId,
} from '@tulipfarm/apps';
import {
  appFilePathSchema,
  appRole,
  discardDraftChanges,
  draftState,
  readApp,
  readBuild,
  readDraft,
  readRelease,
  readSourceBundles,
  readStagedChanges,
  saveDraft,
  stageDraftChange,
  type AppDraft,
  type AppRepositories,
  type AppTransaction,
} from '@tulipfarm/apps/store';
import { activeMembers } from './members.ts';
import { withHuman } from './saved-policy.ts';
import type { AgentStorage, AgentTransaction } from './store.ts';

const readChars = 32_000;
const listedFiles = 500;

export const appToolCallSchemas = [
  z.strictObject({ tool: z.literal('apps.status') }),
  z.strictObject({
    tool: z.literal('apps.files.list'),
    prefix: z.string().max(512).optional().describe('Only paths that start with this text, such as "src/".'),
  }),
  z.strictObject({
    tool: z.literal('apps.files.read'),
    path: appFilePathSchema,
    offset: z.number().int().min(0).max(appLimits.fileBytes).default(0).describe('First character to read.'),
    limit: z.number().int().min(1).max(readChars).default(readChars).describe('Most characters to read.'),
  }),
  z.strictObject({
    tool: z.literal('apps.files.write'),
    path: appFilePathSchema,
    content: z.string().max(appLimits.fileBytes).describe('The whole new text of the file.'),
  }),
  z.strictObject({ tool: z.literal('apps.files.delete'), path: appFilePathSchema }),
  // eslint-disable-next-line tulipfarm/product-copy -- A tool name, not user-facing copy.
  z.strictObject({ tool: z.literal('apps.preview.build') }),
] as const;
const appToolCallSchema = z.discriminatedUnion('tool', appToolCallSchemas);
export type AppToolCall = z.infer<typeof appToolCallSchema>;
export type AppToolName = AppToolCall['tool'];

export const appToolDescriptions: Record<AppToolName, string> = {
  'apps.status':
    'Read the state of the app this chat edits: its draft (empty, editing, building, built, failed or saved), draft revision, live release and edge status, and the newest build of the draft. Changes nothing.',
  'apps.files.list':
    'List the files of the app this chat edits, with their sizes: the saved draft plus changes not yet saved. Pass prefix to list one folder. Changes nothing.',
  'apps.files.read':
    'Read one text file of the app this chat edits, including changes not yet saved. A binary file reports only its size. Long files return nextOffset; pass it as offset to continue. Changes nothing.',
  'apps.files.write':
    'Create or replace one text file in the app this chat edits. Changes stay in the draft, never on the live app, and are saved when your reply ends. Only one chat edits an app at a time; draft-busy means another chat holds it.',
  'apps.files.delete':
    'Delete one file from the draft of the app this chat edits. The live app is unchanged. draft-busy means another chat is editing the app.',
  // eslint-disable-next-line tulipfarm/product-copy -- A tool name, not user-facing copy.
  'apps.preview.build':
    'Save the draft and build a private copy of the app the editor can open beside this chat. Waits up to two minutes and returns the build status. It never publishes; only the editor publishes.',
};

/** The chat a tool call or turn belongs to. */
export type AppChat = {
  readonly workspaceId: string;
  readonly actor: HumanActor;
  readonly conversationId: string;
  readonly signal?: AbortSignal | undefined;
};

/** How the turn that used app tools ended. A completed turn saves its staged changes; any other end drops them. */
export type AppTurnOutcome = 'completed' | 'cancelled' | 'failed';

export type AppEditingOptions = {
  readonly repositories: AppRepositories;
  /** Whether the workspace has app hosting turned on. */
  readonly enabled: (workspaceId: string) => Promise<boolean>;
  /** Records a build of a saved draft commit and starts it, returning the build to wait for. */
  readonly requestBuild: (input: {
    readonly workspaceId: string;
    readonly appId: AppId;
    readonly commit: GitCommit;
    readonly requestedBy: MembershipId;
  }) => Promise<AppBuildId>;
  readonly buildWaitMs?: number;
  readonly buildPollMs?: number;
};

type Failure = { readonly error: AppFailure['code']; readonly message: string; readonly retryable: boolean };
const failure = ({ code, message, retryable }: AppFailure): Failure => ({ error: code, message, retryable });

const appTx = (tx: AgentTransaction): AppTransaction => ({ client: tx.client, schema: tx.schema });
const table = (tx: AppTransaction, name: string) => `${escapeIdentifier(tx.schema)}.${escapeIdentifier(name)}`;
const membership = (actor: HumanActor) => actor.membershipId as MembershipId;
// An expired lease still holds its chat's staged changes until another chat takes the draft.
const chatLease = (draft: AppDraft, chat: AppChat) =>
  draft.lease?.conversationId === chat.conversationId ? draft.lease : null;
const decoder = new TextDecoder('utf-8', { fatal: true });

function text(bytes: Uint8Array) {
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The file tools of an app's own chat. Every call checks again that app hosting is on, that the chat edits a public
 * app and that the person still holds `edit` on it, so a revoked grant stops the next call.
 */
export function createAppEditing(runtime: AgentStorage, options: AppEditingOptions) {
  const { repositories } = options;
  const buildWaitMs = options.buildWaitMs ?? 120_000;
  const buildPollMs = options.buildPollMs ?? 2_000;

  /** The public app this chat edits, while the person still holds `edit` on it. */
  async function editedApp(tx: AppTransaction, chat: AppChat): Promise<AppId | null> {
    const appId = await chatApp(tx, chat.conversationId);
    if (!appId) return null;
    const app = await readApp(tx, appId);
    if (!app || app.kind !== 'public' || app.archivedAt !== null) return null;
    return (await appRole(tx, appId, membership(chat.actor))) === 'edit' ? appId : null;
  }

  /** Runs `action` for the app this chat edits, or refuses when the chat may not edit one. */
  async function withApp<T>(
    chat: AppChat,
    action: (tx: AppTransaction, appId: AppId, raw: AgentTransaction) => Promise<T>,
  ): Promise<T | Failure> {
    if (!(await options.enabled(chat.workspaceId)))
      return failure({ code: 'forbidden', message: 'App hosting is off in this workspace', retryable: false });
    return withHuman(runtime, chat.workspaceId, chat.actor, 'read', async raw => {
      const tx = appTx(raw);
      const appId = await editedApp(tx, chat);
      if (!appId) return failure({ code: 'forbidden', message: 'This chat cannot edit an app', retryable: false });
      return action(tx, appId, raw);
    });
  }

  const transactions =
    (chat: AppChat) =>
    <T>(action: (tx: AppTransaction) => Promise<T>) =>
      withHuman(runtime, chat.workspaceId, chat.actor, 'read', raw => action(appTx(raw)));

  /** The draft head's files with this chat's staged changes applied, as path to size or staged bytes. */
  async function workingTree(chat: AppChat, tx: AppTransaction, appId: AppId, draft: AppDraft) {
    const repository = await repositories.open(
      chat.workspaceId,
      appId,
      draft.headCommit,
      await readSourceBundles(tx, appId),
    );
    const sizes = await repositories.tree(repository, draft.headCommit);
    const staged = new Map<string, Uint8Array | null>();
    const lease = chatLease(draft, chat);
    if (lease)
      for (const change of await readStagedChanges(tx, appId, lease.id)) staged.set(change.path, change.content);
    for (const [path, content] of staged) {
      if (content === null) sizes.delete(path);
      else sizes.set(path, content.byteLength);
    }
    return { repository, sizes, staged };
  }

  async function holderName(raw: AgentTransaction, draft: AppDraft | null) {
    const holder = draft?.lease?.membershipId;
    if (!holder) return null;
    const [member] = await activeMembers(raw, [holder]);
    return member?.name ?? null;
  }

  async function stage(chat: AppChat, path: string, content: Uint8Array | null) {
    return withApp(chat, async (tx, appId, raw) => {
      const draft = await readDraft(tx, appId);
      const { sizes } = await workingTree(chat, tx, appId, { ...draft!, lease: null });
      const staged = await stageDraftChange(
        tx,
        { appId, conversationId: chat.conversationId, membershipId: membership(chat.actor), path, content },
        sizes,
      );
      if (staged.ok) return { revision: staged.revision };
      if (staged.failure.code !== 'draft-busy') return failure(staged.failure);
      const name = await holderName(raw, draft);
      return failure({
        ...staged.failure,
        message: name ? `${name} is editing this app in another chat` : staged.failure.message,
      });
    });
  }

  async function coAuthor(chat: AppChat) {
    const [member] = await withHuman(runtime, chat.workspaceId, chat.actor, 'read', raw =>
      activeMembers(raw, [chat.actor.membershipId]),
    );
    return {
      name: member?.name ?? 'Workspace member',
      email: member?.email ?? `${chat.actor.membershipId}@members.tulipfarm.invalid`,
    };
  }

  /** Saves this chat's staged changes into a commit. Nothing to save, or no lease of this chat, keeps the head. */
  async function save(chat: AppChat, appId: AppId, draft: AppDraft, endLease: boolean) {
    const lease = chatLease(draft, chat);
    if (!lease) return { ok: true as const, commit: draft.headCommit };
    return saveDraft(transactions(chat), repositories, {
      workspaceId: chat.workspaceId,
      appId,
      leaseId: lease.id,
      expectedRevision: draft.revision,
      coAuthor: await coAuthor(chat),
      endLease,
    });
  }

  async function status(chat: AppChat) {
    return withApp(chat, async (tx, appId) => {
      const app = (await readApp(tx, appId))!;
      const draft = (await readDraft(tx, appId))!;
      const [newest] = (
        await tx.client.query(
          `SELECT id FROM ${table(tx, 'tf_app_builds')} WHERE app_id = $1 AND commit = $2
           ORDER BY created_at DESC LIMIT 1`,
          [appId, draft.headCommit],
        )
      ).rows as { id: AppBuildId }[];
      const build = newest ? await readBuild(tx, newest.id) : null;
      const live = app.liveReleaseId ? await readRelease(tx, app.liveReleaseId) : null;
      return {
        title: app.title,
        draft: draftState(draft, build, live),
        revision: draft.revision,
        live: live ? { release: live.number, edge: edgeStatus(app.stops) } : null,
        build: build ? { id: build.id, ...build.status } : null,
      };
    });
  }

  async function list(chat: AppChat, prefix = '') {
    return withApp(chat, async (tx, appId) => {
      const { sizes } = await workingTree(chat, tx, appId, (await readDraft(tx, appId))!);
      const files = [...sizes]
        .filter(([path]) => path.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, bytes]) => ({ path, bytes }));
      return {
        files: files.slice(0, listedFiles),
        ...(files.length > listedFiles ? { truncated: true, total: files.length } : {}),
      };
    });
  }

  async function read(chat: AppChat, path: string, offset: number, limit: number) {
    return withApp(chat, async (tx, appId) => {
      const draft = (await readDraft(tx, appId))!;
      const { repository, sizes, staged } = await workingTree(chat, tx, appId, draft);
      if (!sizes.has(path)) return failure({ code: 'not-found', message: `${path} does not exist`, retryable: false });
      const bytes = staged.get(path) ?? (await repositories.file(repository, draft.headCommit!, path))!;
      const content = text(bytes);
      if (content === null) return { path, binary: true, bytes: bytes.byteLength };
      const end = Math.min(content.length, offset + limit);
      return {
        path,
        content: content.slice(offset, end),
        ...(end < content.length ? { nextOffset: end } : {}),
      };
    });
  }

  async function build(chat: AppChat) {
    const saved = await withApp(chat, async (tx, appId) => ({ appId, draft: (await readDraft(tx, appId))! }));
    if ('error' in saved) return saved;
    const result = await save(chat, saved.appId, saved.draft, false);
    if (!result.ok) return failure(result.failure);
    if (!result.commit)
      return failure({ code: 'not-found', message: 'Write a file before building the app', retryable: false });
    const buildId = await options.requestBuild({
      workspaceId: chat.workspaceId,
      appId: saved.appId,
      commit: result.commit,
      requestedBy: membership(chat.actor),
    });
    const deadline = Date.now() + buildWaitMs;
    for (;;) {
      const current = await withApp(chat, tx => readBuild(tx, buildId));
      if (current && 'error' in current) return current;
      const finished = current?.status.status === 'succeeded' || current?.status.status === 'failed';
      if (finished || Date.now() >= deadline || chat.signal?.aborted)
        return { buildId, commit: result.commit, ...(current?.status ?? { status: 'queued' }) };
      await sleep(buildPollMs, undefined, chat.signal ? { signal: chat.signal } : undefined).catch(() => undefined);
    }
  }

  return {
    /** Whether this chat is offered the app tools. The worker asks once per turn; each call checks again. */
    async admitted(chat: AppChat) {
      return !('error' in (await withApp(chat, async () => ({ admitted: true }))));
    },

    invoke(chat: AppChat, call: AppToolCall): Promise<unknown> {
      switch (call.tool) {
        case 'apps.status':
          return status(chat);
        case 'apps.files.list':
          return list(chat, call.prefix);
        case 'apps.files.read':
          return read(chat, call.path, call.offset, call.limit);
        case 'apps.files.write':
          return stage(chat, call.path, new TextEncoder().encode(call.content));
        case 'apps.files.delete':
          return stage(chat, call.path, null);
        // eslint-disable-next-line tulipfarm/product-copy -- A tool name, not user-facing copy.
        case 'apps.preview.build':
          return build(chat);
      }
    },

    /**
     * Ends this chat's edit at the end of a turn. A completed turn saves what it staged and frees the lease; a cancelled
     * or failed turn drops what it staged and frees the lease, so the saved draft and the live app stay as they were.
     */
    async finishTurn(chat: AppChat, outcome: AppTurnOutcome): Promise<{ saved: GitCommit | null } | Failure> {
      const held = await withHuman(runtime, chat.workspaceId, chat.actor, 'read', async raw => {
        const tx = appTx(raw);
        const appId = await chatApp(tx, chat.conversationId);
        const draft = appId && (await readDraft(tx, appId));
        if (!appId || !draft?.lease || draft.lease.conversationId !== chat.conversationId) return null;
        // Changes of a person who lost edit during the turn are dropped, not saved under their name.
        if (outcome === 'completed' && (await editedApp(tx, chat)) === appId) return { appId, draft };
        await discardDraftChanges(tx, appId, draft.lease.id);
        return null;
      });
      if (!held) return { saved: null };
      const saved = await save(chat, held.appId, held.draft, true);
      return saved.ok ? { saved: saved.commit } : failure(saved.failure);
    },
  };
}
export type AppEditing = ReturnType<typeof createAppEditing>;

/** The app a chat belongs to, or null for any other chat. */
export async function chatApp(tx: AppTransaction, conversationId: string) {
  const found = await tx.client.query(`SELECT app_id FROM ${table(tx, 'tf_conversations')} WHERE id = $1`, [
    conversationId,
  ]);
  return ((found.rows[0] as { app_id: string | null } | undefined)?.app_id ?? null) as AppId | null;
}
