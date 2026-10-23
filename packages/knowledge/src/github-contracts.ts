import { z } from 'zod';
import { knowledgeCitationSchema } from './contracts.ts';

export const githubCorpusLimits = Object.freeze({
  repositories: 1000,
  excludePatterns: 20,
  excludePatternLength: 200,
  listPageSize: 100,
  issuePageSize: 100,
  // GitHub's largest page of commits; each commit's changed files are read in pages of GitHub's own size.
  commitPageSize: 100,
  // GitHub lists at most this many changed files for one commit.
  commitFiles: 3000,
  // Files are indexed in parts of about this many bytes, split at a line break, so any file size fits the parser.
  partBytes: 128 * 1024,
  // Issues and discussions are indexed in parts of this many top-level comments.
  commentsPerPart: 100,
  // One stored item's Markdown; larger issue or discussion parts are reported as too large.
  markdownBytes: 1024 * 1024,
  // JSON metadata responses only; file content is streamed and never buffered whole.
  responseBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 10000,
  blobTimeoutMs: 10 * 60 * 1000,
  // Larger or truncated recursive trees are walked one directory at a time.
  recursiveTreeEntries: 10000,
  treeRequestsPerPage: 50,
});
const printable = (value: string) => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
export const githubRepositoryNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
  .refine(value => !value.endsWith('/.') && !value.endsWith('/..'));
export const githubRepositoryIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const githubCorpusCursorTokenSchema = z.string().min(1).max(4096).refine(printable);
// Adding a kind here turns it on for automatic sources, which select every kind.
export const githubCorpusKinds = ['code', 'commits', 'discussions', 'docs', 'issues', 'pulls'] as const;
export const githubCorpusKindSchema = z.enum(githubCorpusKinds);
// Opt-out patterns run on a backtracking engine, so only shapes with a small, bounded cost are accepted: no repeated
// group whose body can itself repeat or branch (`(a+)+`, `(a|a)*`), no backreferences, at most one unbounded
// repetition and a few optional parts (one beside an unbounded repetition). Patterns search anywhere in the path, so a leading `^.*` or trailing `.*$` is
// redundant and is removed before counting. Paths are at most 1,024 characters, which bounds each test.
function patternShape(pattern: string) {
  const groups: boolean[] = [];
  let unbounded = 0,
    bounded = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '\\') {
      if (/[1-9k]/.test(pattern[index + 1] ?? '')) return null;
      index++;
    } else if (char === '[') {
      for (index++; index < pattern.length && pattern[index] !== ']'; index++) if (pattern[index] === '\\') index++;
    } else if (char === '(') {
      groups.push(false);
      if (pattern[index + 1] === '?') index++;
    } else if (char === ')') {
      const inner = groups.pop() ?? false;
      const next = pattern[index + 1] ?? '';
      if (inner && '*+{'.includes(next)) return null;
      if (groups.length) groups[groups.length - 1] ||= inner || '*+?{'.includes(next);
    } else if ('*+?{|'.includes(char ?? '')) {
      if (char === '*' || char === '+') unbounded++;
      else if (char === '{') {
        const close = pattern.indexOf('}', index);
        const [low = '', high] = pattern.slice(index + 1, close < 0 ? index + 1 : close).split(',');
        if (high === '' || Number(high) - Number(low) > 16) unbounded++;
        else bounded++;
      } else if (char === '?' && pattern[index - 1] !== '*' && pattern[index - 1] !== '+' && pattern[index - 1] !== '}')
        bounded++;
      if (groups.length) groups[groups.length - 1] = true;
    }
  }
  // Each optional part multiplies the backtracking of an unbounded repetition, so together only one is allowed.
  return unbounded === 0 ? (bounded <= 4 ? pattern : null) : unbounded === 1 && bounded <= 1 ? pattern : null;
}
const redundant = (pattern: string) => pattern.replace(/^\^?\.\*\??/, '').replace(/(^|[^\\])\.\*\??\$?$/, '$1') || '.';
export function githubExcludePatternProblem(pattern: string): 'length' | 'unsafe' | 'invalid' | null {
  if (!pattern.length || pattern.length > githubCorpusLimits.excludePatternLength) return 'length';
  if (!patternShape(redundant(pattern))) return 'unsafe';
  try {
    new RegExp(pattern, 'su');
  } catch {
    return 'invalid';
  }
  return null;
}
export const githubExcludePatternSchema = z
  .string()
  .refine(pattern => githubExcludePatternProblem(pattern) === null, 'Pattern is not a safe regular expression');
export const githubCorpusKindsSchema = z
  .array(githubCorpusKindSchema)
  .min(1)
  .max(githubCorpusKinds.length)
  .refine(
    kinds =>
      new Set(kinds).size === kinds.length &&
      kinds.every((kind, index) => index === 0 || (kinds[index - 1] ?? '') < kind),
    'Kinds must be unique and sorted',
  );
export const githubCorpusSelectionSchema = z
  .strictObject({
    // `all` follows every repository the account can read; `repositories` is then empty and opt-outs are stored per source.
    scope: z.literal('all').optional(),
    repositories: z
      .array(githubRepositoryNameSchema)
      .max(githubCorpusLimits.repositories)
      .refine(
        names =>
          new Set(names.map(name => name.toLowerCase())).size === names.length &&
          names.every((name, index) => index === 0 || (names[index - 1] ?? '').toLowerCase() < name.toLowerCase()),
        'Repositories must be unique and sorted',
      ),
    kinds: githubCorpusKindsSchema,
    // Repository-relative file paths matching any pattern are never indexed.
    excludePaths: z.array(githubExcludePatternSchema).max(githubCorpusLimits.excludePatterns).optional(),
    // Issues, pull requests and discussions updated before this date are skipped. Absent means full history. Files and
    // commits are not date-bounded.
    after: z.iso.date().optional(),
  })
  .refine(
    selection => (selection.scope === 'all' ? selection.repositories.length === 0 : selection.repositories.length > 0),
    'Select repositories, or every repository',
  );
const compiled = new Map<string, RegExp>();
function excludePattern(pattern: string) {
  let value = compiled.get(pattern);
  if (!value) {
    value = new RegExp(redundant(pattern), 'su');
    if (compiled.size >= 1000) compiled.clear();
    compiled.set(pattern, value);
  }
  return value;
}
/** True when a repository-relative file path matches one of the selection's opt-out patterns. */
export function githubPathOptedOut(selection: Pick<GitHubCorpusSelection, 'excludePaths'>, path: string) {
  return path.length <= 1024 && !!selection.excludePaths?.some(pattern => excludePattern(pattern).test(path));
}
export const githubCorpusBindingSchema = z.strictObject({
  accountId: z.uuid(),
  accountGeneration: z.number().int().positive(),
  githubUserId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  login: z.string().min(1).max(39),
});
export const githubCorpusErrorCodeSchema = z.enum([
  'not-configured',
  'not-linked',
  'stale-integration',
  'reconnect-required',
  'insufficient-scope',
  'unauthenticated',
  'forbidden',
  'not-found',
  'outside-selection',
  'rate-limited',
  'transient',
  'invalid-response',
  'response-too-large',
  'invalid-cursor',
  'invalid-selection',
  'source-changed',
  'too-large',
  'unsupported',
]);
export type GitHubCorpusErrorCode = z.infer<typeof githubCorpusErrorCodeSchema>;
export class GitHubCorpusError extends Error {
  readonly code: GitHubCorpusErrorCode;
  readonly retryAfterMs: number | null;
  constructor(code: GitHubCorpusErrorCode, retryAfterMs: number | null = null) {
    super(code);
    this.name = 'GitHubCorpusError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
export type GitHubCorpusSelection = z.infer<typeof githubCorpusSelectionSchema>;
export type GitHubCorpusKind = z.infer<typeof githubCorpusKindSchema>;
export type GitHubCorpusBinding = z.infer<typeof githubCorpusBindingSchema>;
export type GitHubRepository = {
  repositoryId: string;
  fullName: string;
  visibility: 'public' | 'private' | 'internal';
  title: string;
};
// `readable` is the reader's own current pull access, observed with their own account at `accessedAt`.
export type GitHubRepositoryAccess = GitHubRepository & { accessedAt: string; readable: boolean };
export type GitHubItemObservation = {
  nativeId: string;
  repositoryId: string;
  kind: 'doc' | 'code' | 'issue' | 'pull' | 'discussion' | 'commit';
  title: string;
  canonicalURL: string;
  sourceRevision: string;
  accessedAt: string;
  // `denied` marks a kind the connection cannot read in a repository it can still see.
  coverage: 'supported' | 'too-large' | 'unsupported' | 'excluded' | 'denied';
  // The full repository path of a file; `nativeId` carries only its hash when the path is longer than 1,024 bytes.
  path?: string;
};
export type GitHubCorpusPage = {
  observations: GitHubItemObservation[];
  nextCursor: string | null;
  // Set on the page that finishes a repository's commit listing. `head` is the default-branch commit whose whole
  // history is now listed; `retained` means only commits newer than the caller's `commitHead` were listed, so every
  // commit item already stored for the repository is still current.
  commits?: { head: string; retained: boolean };
  // Files, by their first part's native ID, whose parts not observed on this page no longer exist: files removed or
  // renamed away between two commits, and changed files that may now have fewer parts.
  removed?: string[];
  // Progress this page adds to the repository's mark.
  mark?: GitHubRepositoryMark;
  // The incremental listing could not be trusted, so the next pass must fully reconcile.
  reconcile?: boolean;
};
/**
 * Where one repository's last completed listing ended: the default-branch head whose files were listed, and when the
 * listings of issues and pull requests and of discussions started. An incremental listing starts from it.
 */
export type GitHubRepositoryMark = {
  head?: string | undefined;
  issues?: string | undefined;
  discussions?: string | undefined;
};
/** Repositories that GitHub reported as changed, by numeric ID; `all` stands for every repository of an installation. */
export type GitHubKnowledgeChanges = { repositories: readonly string[]; all: boolean };
export type GitHubListHistory = {
  // The last default-branch head whose every commit was listed.
  commitHead: string | null;
  // When present, list only what changed since this mark; otherwise list everything in scope.
  mark?: GitHubRepositoryMark;
  // The default-branch head this pass already read for the repository's files; the commit listing pins to it too.
  head?: string;
};
export type GitHubItemRead = GitHubItemObservation & { markdown: string };
export type GitHubCorpusProvider = {
  discover(
    workspaceId: string,
    userId: string,
    accountId: string,
    cursor?: string,
    // Also lists private repositories the credential's scopes cannot read, so they can be reported as needing permission.
    options?: { includeUnreadable?: boolean },
  ): Promise<{ binding: GitHubCorpusBinding; items: GitHubRepository[]; nextCursor: string | null }>;
  inspectSelection(
    workspaceId: string,
    userId: string,
    accountId: string,
    selection: GitHubCorpusSelection,
  ): Promise<{ binding: GitHubCorpusBinding; title: string; repositories: GitHubRepository[] }>;
  access(
    workspaceId: string,
    userId: string,
    binding: GitHubCorpusBinding,
    repositoryId: string,
  ): Promise<GitHubRepositoryAccess>;
  list(
    workspaceId: string,
    userId: string,
    binding: GitHubCorpusBinding,
    repositoryId: string,
    selection: GitHubCorpusSelection,
    cursor: string | null,
    history?: GitHubListHistory,
  ): Promise<GitHubCorpusPage>;
  read(
    workspaceId: string,
    userId: string,
    binding: GitHubCorpusBinding,
    repositoryId: string,
    nativeId: string,
    selection: GitHubCorpusSelection,
    path?: string | null,
  ): Promise<GitHubItemRead>;
};

export const githubKnowledgeConfigureSchema = z.strictObject({
  commandId: z.uuid(),
  accountId: z.uuid(),
  selection: githubCorpusSelectionSchema,
  memberIds: z.array(z.uuid()).max(100),
});
export const githubKnowledgeSettingsSchema = z.strictObject({
  commandId: z.uuid(),
  kinds: githubCorpusKindsSchema,
  excludePaths: z.array(githubExcludePatternSchema).max(githubCorpusLimits.excludePatterns),
  after: z.iso.date().nullable(),
  // The complete set of the source's repositories to leave out; every other repository is indexed.
  excludedRepositories: z.array(githubRepositoryIdSchema).max(githubCorpusLimits.repositories),
});
export const githubKnowledgeManageSchema = z.strictObject({
  commandId: z.uuid(),
  action: z.enum(['pause', 'resume', 'retry', 'remove']),
});
export const githubKnowledgeWorkSchema = z.strictObject({
  workspaceId: z.uuid(),
  sourceId: z.uuid(),
  generation: z.number().int().positive(),
});
export const githubKnowledgeDiscoverSchema = z.strictObject({
  accountId: z.uuid(),
  cursor: githubCorpusCursorTokenSchema.optional(),
});
const repositorySchema = z.strictObject({
  repositoryId: githubRepositoryIdSchema,
  fullName: githubRepositoryNameSchema,
  visibility: z.enum(['public', 'private', 'internal']),
  title: z.string().max(512),
});
export const githubKnowledgeDiscoverySchema = z.strictObject({
  binding: githubCorpusBindingSchema,
  items: z.array(repositorySchema).max(100),
  nextCursor: githubCorpusCursorTokenSchema.nullable(),
});
// `needs-permission`: the repository is visible but some selected kinds cannot be read (`missingKinds`).
// `access-lost`: the repository can no longer be read at all; its content stays hidden until access returns.
export const githubKnowledgeRepositoryStatusSchema = z.enum(['active', 'excluded', 'needs-permission', 'access-lost']);
export const githubKnowledgeRepositorySchema = repositorySchema.extend({
  state: z.enum(['active', 'unavailable']),
  failure: z.string().max(128).nullable(),
  excluded: z.boolean(),
  status: githubKnowledgeRepositoryStatusSchema,
  missingKinds: z.array(githubCorpusKindSchema).max(githubCorpusKinds.length),
});
export const githubKnowledgeRepositoryCountsSchema = z.strictObject({
  active: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  needsPermission: z.number().int().nonnegative(),
  accessLost: z.number().int().nonnegative(),
});
export const githubKnowledgeSourceSchema = z.strictObject({
  sourceId: z.uuid(),
  selection: githubCorpusSelectionSchema.nullable(),
  memberIds: z.array(z.uuid()).max(101),
  title: z.string().max(2048),
  canManage: z.boolean(),
  state: z.enum(['active', 'paused', 'disconnected', 'removed']),
  syncState: z.enum(['queued', 'syncing', 'ready', 'failed']),
  failure: z.string().max(128).nullable(),
  nextAttemptAt: z.iso.datetime(),
  // `reconnect-required` when the owner's GitHub account was revoked, expired or disconnected; sync resumes on reconnect.
  connection: z.enum(['connected', 'reconnect-required']),
  // The owner's GitHub account to reconnect; null for members who do not manage the source.
  accountId: z.uuid().nullable(),
  repositoryCounts: githubKnowledgeRepositoryCountsSchema.nullable(),
  repositories: z.array(githubKnowledgeRepositorySchema).max(githubCorpusLimits.repositories).nullable(),
  counts: z
    .strictObject({
      total: z.number().int().nonnegative(),
      ready: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type GitHubKnowledgeConfigure = z.infer<typeof githubKnowledgeConfigureSchema>;
export type GitHubKnowledgeSettings = z.infer<typeof githubKnowledgeSettingsSchema>;
export type GitHubKnowledgeManage = z.infer<typeof githubKnowledgeManageSchema>;
export type GitHubKnowledgeWork = z.infer<typeof githubKnowledgeWorkSchema>;
export type GitHubKnowledgeSource = z.infer<typeof githubKnowledgeSourceSchema>;
export const githubKnowledgeListSchema = z.strictObject({ items: z.array(githubKnowledgeSourceSchema).max(100) });
export const githubKnowledgeRefreshSchema = z.strictObject({
  refreshed: z.number().int().min(0).max(20),
  unavailable: z.number().int().min(0).max(20),
  bounded: z.literal(true),
});
export const githubKnowledgeEvidenceSchema = z.strictObject({
  title: z.string().max(512),
  text: z.string().max(32768),
  heading: z.string().max(2048),
  citation: knowledgeCitationSchema,
  original: z.strictObject({ kind: z.literal('github') }),
  validUntil: z.iso.datetime(),
});
export const githubKnowledgeStatusSchema = z.strictObject({
  documentId: z.uuid(),
  revisionId: z.uuid(),
  title: z.string().max(512),
  publicationId: z.uuid().nullable(),
  parsing: z.enum(['queued', 'parsing', 'ready', 'failed', 'ocr-unavailable']),
  embedding: z.enum(['pending', 'failed', 'credits-blocked', 'ready']),
  failure: z.string().max(128).nullable(),
  historical: z.boolean(),
});
export const githubKnowledgeDocumentsQuerySchema = z.strictObject({ cursor: z.uuid().optional() });
export const githubKnowledgeDocumentsSchema = z.strictObject({
  items: z.array(githubKnowledgeStatusSchema.extend({ canRetry: z.boolean() })).max(20),
  nextCursor: z.uuid().nullable(),
});
