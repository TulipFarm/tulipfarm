import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { log, observeFetch, type DependencyEndpoint } from '@tulipfarm/observability';
import { AccessDenied } from '@tulipfarm/access';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import {
  GitHubCorpusError,
  githubCorpusBindingSchema,
  githubCorpusCursorTokenSchema,
  githubCorpusLimits as limits,
  githubCorpusSelectionSchema,
  githubPathOptedOut,
  githubRepositoryIdSchema,
  githubRepositoryNameSchema,
  type GitHubCorpusBinding,
  type GitHubCorpusErrorCode,
  type GitHubCorpusProvider,
  type GitHubCorpusSelection,
  type GitHubItemObservation,
  type GitHubItemRead,
  type GitHubFilePart,
  type GitHubCorpusPage,
  type GitHubListHistory,
  type GitHubRepository,
  type GitHubRepositoryMark,
} from '@tulipfarm/knowledge/github-contracts';
import {
  createGitHubAccounts,
  GitHubAccountError,
  GitHubCredentialRejected,
  githubConfiguration,
  type AccountRuntime,
  type GitHubCredential,
} from './accounts.ts';

type Accounts = Pick<ReturnType<typeof createGitHubAccounts>, 'withReadCredential'>;
// Transient failures (network, timeout, 5xx) are retried in place before the engine isolates the item or repository.
const requestAttempts = 4;
const retryBaseMs = 500;
const retryCapMs = 8000;
// Below this share of the hourly budget, requests are spread evenly until the reset; the reserve is left for interactive reads.
const paceBelowRatio = 0.2;
const rateReserveRatio = 0.05;
const maxPaceMs = 10_000;
// GraphQL and REST have separate GitHub budgets.
const budgetKey = (token: string, endpoint: DependencyEndpoint) =>
  `${createHash('sha256').update(token).digest('hex').slice(0, 32)}:${endpoint === 'github-graphql' ? 'graphql' : 'core'}`;
const repositorySchema = z.object({
  id: z.number().int().positive(),
  node_id: z.string().min(1).max(256),
  full_name: githubRepositoryNameSchema,
  private: z.boolean(),
  visibility: z.enum(['public', 'private', 'internal']).optional(),
  default_branch: z.string().min(1).max(255).optional(),
  description: z.string().max(4096).nullable().optional(),
  permissions: z.object({ pull: z.boolean() }).partial().optional(),
});
type RepositoryBody = z.infer<typeof repositorySchema>;
const userSchema = z
  .object({ login: z.string().max(100) })
  .nullable()
  .optional();
const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1024),
  body: z.string().max(262144).nullable().optional(),
  user: userSchema,
  state: z.string().max(32),
  created_at: z.string(),
  updated_at: z.string(),
  comments: z.number().int().nonnegative(),
  html_url: z.url(),
  pull_request: z.object({}).passthrough().optional(),
});
type Issue = z.infer<typeof issueSchema>;
const commentSchema = z.object({
  user: userSchema,
  body: z.string().max(262144).nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
const shaPattern = /^[a-f0-9]{40,64}$/;
const gitPersonSchema = z
  .object({ name: z.string().max(1024).nullable().optional(), date: z.string().max(64).nullable().optional() })
  .nullable()
  .optional();
const commitSchema = z.object({
  sha: z.string().regex(shaPattern),
  commit: z.object({
    message: z.string().max(limits.responseBytes),
    author: gitPersonSchema,
    committer: gitPersonSchema,
  }),
  author: userSchema,
  committer: userSchema,
  parents: z.array(z.object({ sha: z.string().regex(shaPattern) })).max(1000),
});
type Commit = z.infer<typeof commitSchema>;
const commitFileSchema = z.object({
  filename: z.string().max(65536),
  status: z.string().max(32),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  previous_filename: z.string().max(65536).optional(),
});
export type GitHubCommitFile = z.infer<typeof commitFileSchema>;
const commitDetailSchema = commitSchema.extend({ files: z.array(commitFileSchema).max(limits.commitFiles).optional() });
// The Git database view of a commit has no GitHub logins or files; it stands in when GitHub cannot return the diff.
const gitCommitSchema = z.object({
  sha: z.string().regex(shaPattern),
  message: z.string().max(limits.responseBytes),
  author: gitPersonSchema,
  committer: gitPersonSchema,
  parents: z.array(z.object({ sha: z.string().regex(shaPattern) })).max(1000),
});
const compareSchema = z.object({
  status: z.enum(['ahead', 'behind', 'diverged', 'identical']),
  total_commits: z.number().int().nonnegative(),
  commits: z.array(commitSchema).max(250),
});
const treeEntrySchema = z.object({
  path: z.string().max(65536),
  type: z.string(),
  sha: z.string().regex(shaPattern),
  size: z.number().int().nonnegative().optional(),
});
type TreeEntry = z.infer<typeof treeEntrySchema>;
const treeSchema = z.object({ truncated: z.boolean().optional(), tree: z.array(treeEntrySchema).max(200000) });
// A comparison lists changed files only on its first page, and never more than 300 for the whole comparison.
const compareFileLimit = 300;
const compareFilesSchema = z.object({
  status: z.enum(['ahead', 'behind', 'diverged', 'identical']),
  files: z
    .array(z.object({ filename: z.string(), status: z.string(), previous_filename: z.string().optional() }))
    .max(compareFileLimit)
    .optional(),
});
// Incremental listings re-read anything updated this long before the previous listing started, absorbing clock skew.
const markOverlapMs = 5 * 60 * 1000;
const contentSchema = z.object({
  type: z.enum(['file', 'symlink']),
  sha: z.string().regex(shaPattern),
  size: z.number().int().nonnegative(),
  encoding: z.string().optional(),
  content: z.string().optional(),
});
const graphAuthor = z
  .object({ login: z.string().max(100) })
  .nullable()
  .optional();
const discussionNode = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1024),
  updatedAt: z.string(),
  url: z.url(),
  comments: z.object({ totalCount: z.number().int().nonnegative() }),
});
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().max(1024).nullable() });
const replySchema = z.object({
  body: z.string().max(262144),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: graphAuthor,
});
const commentNode = replySchema.extend({
  id: z.string().min(1).max(256),
  replies: z.object({
    totalCount: z.number().int().nonnegative(),
    pageInfo,
    nodes: z.array(replySchema).max(100),
  }),
});
const discussionPageSchema = discussionNode.extend({
  body: z.string().max(262144),
  createdAt: z.string(),
  author: graphAuthor,
  category: z
    .object({ name: z.string().max(256) })
    .nullable()
    .optional(),
  comments: z.object({ totalCount: z.number().int().nonnegative(), nodes: z.array(commentNode).max(100) }),
});
const commentCursorSchema = z.object({
  node: z
    .object({
      discussion: z
        .object({ comments: z.object({ pageInfo }) })
        .nullable()
        .optional(),
    })
    .nullable(),
});
type FileRef = { sha: string; size: number; content?: Uint8Array };
type GitHubDiscussion = Omit<z.infer<typeof discussionPageSchema>, 'comments'> & {
  comments: {
    totalCount: number;
    nodes: (z.infer<typeof replySchema> & { replies: { nodes: z.infer<typeof replySchema>[] } })[];
  };
};
const documentExtensions = /\.(?:md|markdown|mdx|mdown|txt|text|rst|adoc|asciidoc|org)$/i;
const documentNames = /(?:^|\/)(?:README|CHANGELOG|CHANGES|CONTRIBUTING|LICENSE|NOTICE|AUTHORS|CODEOWNERS|SECURITY)$/i;
/** Labels a file as documentation (`doc`); every other file is `code`. The label never decides whether a file is indexed. */
export const isGitHubDocumentPath = (path: string) => documentExtensions.test(path) || documentNames.test(path);
export const githubFileKind = (path: string): 'doc' | 'code' => (isGitHubDocumentPath(path) ? 'doc' : 'code');
const binaryExtensions: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  ico: 'image/vnd.microsoft.icon',
  icns: 'image/icns',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svgz: 'image/svg+xml',
  heic: 'image/heic',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  jar: 'application/java-archive',
  war: 'application/java-archive',
  class: 'application/java-vm',
  exe: 'application/vnd.microsoft.portable-executable',
  dll: 'application/vnd.microsoft.portable-executable',
  so: 'application/octet-stream',
  dylib: 'application/octet-stream',
  o: 'application/octet-stream',
  a: 'application/octet-stream',
  lib: 'application/octet-stream',
  bin: 'application/octet-stream',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  webm: 'video/webm',
  psd: 'image/vnd.adobe.photoshop',
  sketch: 'application/octet-stream',
  fig: 'application/octet-stream',
  sqlite: 'application/vnd.sqlite3',
  sqlite3: 'application/vnd.sqlite3',
  db: 'application/octet-stream',
  parquet: 'application/vnd.apache.parquet',
  pyc: 'application/octet-stream',
  pyo: 'application/octet-stream',
  npy: 'application/octet-stream',
  pkl: 'application/octet-stream',
  onnx: 'application/octet-stream',
  pt: 'application/octet-stream',
  h5: 'application/x-hdf5',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  odg: 'application/vnd.oasis.opendocument.graphics',
  odf: 'application/vnd.oasis.opendocument.formula',
  epub: 'application/epub+zip',
  key: 'application/vnd.apple.keynote',
  pages: 'application/vnd.apple.pages',
  numbers: 'application/vnd.apple.numbers',
};
const extension = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
/** Known binary formats get one metadata placeholder instead of text parts; other files are sniffed when read. */
export const isGitHubBinaryPath = (path: string) => Object.hasOwn(binaryExtensions, extension(path));
const mediaTypeOf = (path: string) => binaryExtensions[extension(path)] ?? 'application/octet-stream';
/**
 * Whether a default-branch file is indexed. Every file is, with no built-in exclusions; a source's own opt-out
 * patterns compose with this check.
 */
export const githubPathIndexable = (path: string) => path.length > 0;
// Content extraction for binary files (for example OCR). Without an extractor a binary file is a metadata placeholder.
export type GitHubBinaryFile = {
  path: string;
  mediaType: string;
  size: number;
  content(): AsyncIterable<Uint8Array>;
};
export type GitHubBinaryExtractor = (file: GitHubBinaryFile) => Promise<string | null>;
const fence = (content: string) =>
  '`'.repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map(match => match[0].length + 1)));
const DISCUSSIONS = `query($id:ID!,$cursor:String){node(id:$id){... on Repository{discussions(first:${limits.listPageSize},after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{number title updatedAt url comments{totalCount}}}}}}`;
const REPLY = 'body createdAt updatedAt author{login}';
const DISCUSSION = `query($id:ID!,$number:Int!,$after:String){node(id:$id){... on Repository{discussion(number:$number){number title body url createdAt updatedAt author{login} category{name} comments(first:100,after:$after){totalCount nodes{id ${REPLY} replies(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{${REPLY}}}}}}}}}`;
const DISCUSSION_COMMENT_CURSOR = `query($id:ID!,$number:Int!,$after:String){node(id:$id){... on Repository{discussion(number:$number){comments(first:100,after:$after){pageInfo{hasNextPage endCursor}}}}}}`;
const DISCUSSION_REPLIES = `query($id:ID!,$after:String){node(id:$id){... on DiscussionComment{replies(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{${REPLY}}}}}}`;

function parse<T>(schema: z.ZodType<T>, value: unknown, code: GitHubCorpusErrorCode = 'invalid-response'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GitHubCorpusError(code);
  return result.data;
}
const iso = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : value;
};
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const who = (user: { login: string } | null | undefined) => (user ? `@${user.login}` : 'a deleted user');
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();
function repository(body: RepositoryBody): GitHubRepository {
  return {
    repositoryId: String(body.id),
    fullName: body.full_name,
    visibility: body.visibility ?? (body.private ? 'private' : 'public'),
    title: (body.description ? `${body.full_name} — ${oneLine(body.description)}` : body.full_name).slice(0, 512),
  };
}
type Phase = 'docs' | 'code' | 'issues' | 'discussions' | 'commits';
// Commits come last: a long history never delays the other kinds of a repository.
function phases(selection: GitHubCorpusSelection): Phase[] {
  return [
    ...(selection.kinds.includes('docs') ? ['docs' as const] : []),
    ...(selection.kinds.includes('code') ? ['code' as const] : []),
    ...(selection.kinds.includes('issues') || selection.kinds.includes('pulls') ? ['issues' as const] : []),
    ...(selection.kinds.includes('discussions') ? ['discussions' as const] : []),
    ...(selection.kinds.includes('commits') ? ['commits' as const] : []),
  ];
}
function nextPhase(selection: GitHubCorpusSelection, current: Phase) {
  const order = phases(selection);
  const next = order[order.indexOf(current) + 1];
  return next ? `${next}:` : null;
}
const filePhase = (phase: string): phase is 'docs' | 'code' => phase === 'docs' || phase === 'code';
// The phase after every file phase, used when one comparison stands in for the docs and code listings.
function afterFiles(selection: GitHubCorpusSelection) {
  const next = phases(selection).find(phase => !filePhase(phase));
  return next ? `${next}:` : null;
}
// The later of the selection's cutoff and the previous listing's start less a small overlap; undefined lists everything.
const issueTime = (second: number) => new Date(second * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
function issueCursor(state: string) {
  if (!state || /^\d{1,9}$/.test(state)) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)(?:\/([2-9]|[1-9]\d{1,6}))?$/.exec(state);
  const time = match ? Date.parse(match[1] ?? '') : NaN;
  if (!match || !Number.isFinite(time) || issueTime(time / 1000) !== match[1])
    throw new GitHubCorpusError('invalid-cursor');
  return { time: time / 1000, page: Number(match[2] ?? 1) };
}
function since(selection: GitHubCorpusSelection, mark: string | undefined) {
  const time = Math.max(
    ...[
      selection.after ? Date.parse(`${selection.after}T00:00:00Z`) : NaN,
      mark ? Date.parse(mark) - markOverlapMs : NaN,
    ].filter(Number.isFinite),
  );
  return Number.isFinite(time) ? new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z') : undefined;
}
const hashPath = (path: string) => createHash('sha256').update(path).digest('hex');
// Native IDs keep the full path up to 1,024 bytes; a longer path is identified by its hash and kept in `path`.
const pathRef = (path: string) => (Buffer.byteLength(path) > 1024 ? `/h/${hashPath(path)}` : path);
// Part 1 keeps the plain ID, so an item that later grows into parts keeps its first document.
const partRest = (part: number, ref: string) => (part > 1 ? `/p/${part}/${ref}` : ref);
type Native = {
  kind: 'doc' | 'code' | 'issue' | 'pull' | 'discussion' | 'commit';
  part: number;
  ref: string;
  hash: string | null;
  marker: boolean;
};
function native(nativeId: string, repositoryId: string): Native {
  const match = /^(doc|code|issue|pull|discussion|commit):([1-9][0-9]{0,19}):(.+)$/s.exec(nativeId);
  if (!match || match[2] !== repositoryId) throw new GitHubCorpusError('invalid-selection');
  const kind = match[1] as Native['kind'];
  let rest = match[3] ?? '';
  // A commit is identified by its SHA alone and is never split into parts.
  if (kind === 'commit') {
    if (rest === '/denied') return { kind, part: 1, ref: rest, hash: null, marker: true };
    if (!shaPattern.test(rest)) throw new GitHubCorpusError('invalid-selection');
    return { kind, part: 1, ref: rest, hash: null, marker: false };
  }
  let part = 1;
  const parted = /^\/p\/([2-9]|[1-9][0-9]{1,6})\/(.+)$/s.exec(rest);
  if (parted) {
    part = Number(parted[1]);
    rest = parted[2] ?? '';
  }
  // Marks a kind the connection cannot read in a repository it can still see.
  if (!parted && rest === '/denied') return { kind, part, ref: rest, hash: null, marker: true };
  if (kind !== 'doc' && kind !== 'code') {
    if (!/^[1-9][0-9]{0,9}$/.test(rest)) throw new GitHubCorpusError('invalid-selection');
    return { kind, part, ref: rest, hash: null, marker: false };
  }
  if (!rest.startsWith('/')) {
    if (Buffer.byteLength(rest) > 1024) throw new GitHubCorpusError('invalid-selection');
    return { kind, part, ref: rest, hash: null, marker: false };
  }
  const hashed = /^\/h\/([a-f0-9]{64})$/.exec(rest);
  if (hashed) return { kind, part, ref: rest, hash: hashed[1] ?? '', marker: false };
  // Markers for an omitted tree; earlier versions listed `/truncated-tree`.
  if (!parted && (rest === '/truncated-tree' || /^\/truncated\/[a-f0-9]{40,64}$/.test(rest)))
    return { kind, part, ref: rest, hash: null, marker: true };
  throw new GitHubCorpusError('invalid-selection');
}
const partTitle = (title: string, part: number, parts: number) => {
  const suffix = parts > 1 ? ` (part ${part} of ${parts})` : '';
  return `${title.slice(0, 512 - suffix.length)}${suffix}`;
};
const commentParts = (comments: number) => Math.max(1, Math.ceil(comments / limits.commentsPerPart));
// Part `part` of an issue holds the description (part 1 only) and that part's page of comments.
export function serializeGitHubIssue(
  full: string,
  issue: Issue,
  comments: readonly z.infer<typeof commentSchema>[],
  part = 1,
) {
  const kind = issue.pull_request ? 'pull request' : 'issue';
  const parts = commentParts(issue.comments);
  const first = (part - 1) * limits.commentsPerPart;
  const lines = [
    `# ${full}#${issue.number}: ${oneLine(issue.title)}${parts > 1 ? ` (part ${part} of ${parts})` : ''}`,
    '',
    `GitHub ${kind} ${full}#${issue.number} by ${who(issue.user)}, opened ${iso(issue.created_at)}, state ${issue.state}, last updated ${iso(issue.updated_at)}. ${issue.comments} ${issue.comments === 1 ? 'comment' : 'comments'}.${parts > 1 ? ` This part holds comments ${comments.length ? `${first + 1}–${first + comments.length}` : 'none'}.` : ''}`,
  ];
  if (part === 1)
    lines.push(
      '',
      `## Description by ${who(issue.user)} at ${iso(issue.created_at)}`,
      '',
      issue.body?.trim() || '_No description._',
    );
  for (const comment of comments)
    lines.push(
      '',
      `## Comment by ${who(comment.user)} at ${iso(comment.created_at)}${comment.updated_at !== comment.created_at ? ` (edited ${iso(comment.updated_at)})` : ''}`,
      '',
      comment.body?.trim() || '_No text content._',
    );
  return `${lines.join('\n')}\n`;
}
// Part `part` of a discussion holds the description (part 1 only) and that part's comments with all their replies.
export function serializeGitHubDiscussion(full: string, discussion: GitHubDiscussion, part = 1) {
  const parts = commentParts(discussion.comments.totalCount);
  const lines = [
    `# ${full} discussion #${discussion.number}: ${oneLine(discussion.title)}${parts > 1 ? ` (part ${part} of ${parts})` : ''}`,
    '',
    `GitHub discussion ${full}#${discussion.number}${discussion.category ? ` in ${discussion.category.name}` : ''} by ${who(discussion.author)}, opened ${iso(discussion.createdAt)}, last updated ${iso(discussion.updatedAt)}.`,
  ];
  if (part === 1)
    lines.push(
      '',
      `## Discussion by ${who(discussion.author)} at ${iso(discussion.createdAt)}`,
      '',
      discussion.body.trim() || '_No description._',
    );
  for (const comment of discussion.comments.nodes) {
    lines.push(
      '',
      `## Comment by ${who(comment.author)} at ${iso(comment.createdAt)}`,
      '',
      comment.body.trim() || '_No text content._',
    );
    for (const reply of comment.replies.nodes)
      lines.push(
        '',
        `### Reply by ${who(reply.author)} at ${iso(reply.createdAt)}`,
        '',
        reply.body.trim() || '_No text content._',
      );
  }
  return `${lines.join('\n')}\n`;
}

// The parser accepts only line breaks and tabs among control characters.
const printableText = (value: string) => value.replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\n\t]/gu, '\uFFFD');
const inlineCode = (value: string) => {
  const ticks = '`'.repeat(Math.max(1, ...[...value.matchAll(/`+/g)].map(match => match[0].length + 1)));
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${printableText(value).replace(/\n/g, ' ')}${pad}${ticks}`;
};
const commitSubject = (commit: Commit) => oneLine(printableText(commit.commit.message).split('\n', 1)[0] ?? '');
const commitTitle = (full: string, commit: Commit) =>
  `${full}@${commit.sha.slice(0, 7)}: ${commitSubject(commit) || 'No commit message'}`;
function commitPerson(git: z.infer<typeof gitPersonSchema>, user: z.infer<typeof userSchema>) {
  const name = oneLine(printableText(git?.name ?? ''));
  const login = user ? `@${user.login}` : '';
  return name && login ? `${name} (${login})` : name || login || 'an unknown author';
}
/** Why a commit's file list is incomplete: GitHub's 3,000-file cap, or a page GitHub could not return. */
export type GitHubCommitFilesTruncation = 'file-limit' | 'unavailable';
// One commit: its full message, author and committer, parents and every changed file GitHub lists. Diffs are not included.
export function serializeGitHubCommit(
  full: string,
  commit: Commit,
  files: readonly GitHubCommitFile[],
  truncation: GitHubCommitFilesTruncation | null = null,
) {
  const author = commitPerson(commit.commit.author, commit.author);
  const committer = commitPerson(commit.commit.committer, commit.committer);
  const authored = commit.commit.author?.date ? ` at ${iso(commit.commit.author.date)}` : '';
  const committed = commit.commit.committer?.date ? ` at ${iso(commit.commit.committer.date)}` : '';
  const parents = commit.parents.map(parent => parent.sha.slice(0, 7));
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const lines = [
    `# ${commitTitle(full, commit)}`,
    '',
    `GitHub commit ${commit.sha} on the default branch of ${full}, authored by ${author}${authored} and committed by ${committer}${committed}. ${parents.length ? `${parents.length === 1 ? 'Parent' : 'Parents'} ${parents.join(', ')}` : 'No parents (root commit)'}. ${files.length} changed ${files.length === 1 ? 'file' : 'files'} listed, +${additions} −${deletions} lines.`,
    '',
    '## Message',
    '',
    printableText(commit.commit.message).trim() || '_No commit message._',
    '',
    '## Changed files',
    '',
  ];
  if (!files.length && !truncation) lines.push('_No changed files._');
  for (const file of files)
    lines.push(
      `- ${inlineCode(file.filename)} ${oneLine(file.status)}${file.previous_filename ? ` from ${inlineCode(file.previous_filename)}` : ''}, +${file.additions} −${file.deletions}`,
    );
  if (truncation === 'file-limit')
    lines.push(
      '',
      `_GitHub lists at most ${limits.commitFiles.toLocaleString('en-US')} changed files for one commit; this commit may change more._`,
    );
  if (truncation === 'unavailable')
    lines.push(
      '',
      files.length
        ? "_GitHub could not return the rest of this commit's changed files; only the files listed above are included._"
        : "_GitHub could not return this commit's changed files._",
    );
  return `${lines.join('\n')}\n`;
}

type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'binary';
const sniffBytes = 8000;
// Byte-order marks pick UTF-8 or UTF-16; otherwise a NUL byte marks a binary file.
function sniff(head: Uint8Array): { encoding: Encoding; bom: number } {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: 'utf-8', bom: 3 };
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf-16le', bom: 2 };
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf-16be', bom: 2 };
  return { encoding: head.subarray(0, sniffBytes).includes(0) ? 'binary' : 'utf-8', bom: 0 };
}
const boundarySearchBytes = 16 * 1024;
// The first part boundary at or after `position`: just past a line break within reach, else the next character start.
function boundary(window: Uint8Array, offset: number, position: number, size: number, encoding: Encoding) {
  if (position >= size) return size;
  const at = (index: number) => window[index - offset] ?? 0;
  const limit = Math.min(size, position + boundarySearchBytes, offset + window.byteLength);
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const start = position % 2 ? position + 1 : position;
    const [low, high] = encoding === 'utf-16le' ? [0, 1] : [1, 0];
    for (let index = start; index + 1 < limit; index += 2)
      if (at(index + low) === 0x0a && at(index + high) === 0) return index + 2;
    const unit = encoding === 'utf-16le' ? at(start) | (at(start + 1) << 8) : (at(start) << 8) | at(start + 1);
    return Math.min(size, unit >= 0xdc00 && unit <= 0xdfff ? start + 2 : start);
  }
  for (let index = position; index < limit; index++) if (at(index) === 0x0a) return index + 1;
  let index = position;
  while (index < Math.min(size, position + 4) && (at(index) & 0xc0) === 0x80) index++;
  return index;
}
function decode(bytes: Uint8Array, encoding: Encoding) {
  let text: string;
  if (encoding === 'utf-16le' || encoding === 'utf-16be') text = new TextDecoder(encoding).decode(bytes);
  else
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // Not UTF-8: read as Windows-1252 (a superset of Latin-1) so legacy text stays readable.
      text = new TextDecoder('windows-1252').decode(bytes);
    }
  // The parser accepts only line breaks and tabs among control characters.
  return text.replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\n\t]/gu, '\uFFFD');
}

// Runs one operation with the caller's own personal GitHub account. Every corpus request is made with this identity only.
export function createGitHubCorpusProvider(options: {
  accounts: Accounts;
  fetcher?: typeof fetch;
  extractBinary?: GitHubBinaryExtractor;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): GitHubCorpusProvider {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => wait(ms));
  const random = options.random ?? Math.random;
  const budgets = new Map<string, { remaining: number; limit: number; resetAt: number }>();
  async function withAccount<T>(
    workspaceId: string,
    userId: string,
    accountId: string,
    expected: GitHubCorpusBinding | null,
    operation: (credential: GitHubCredential, binding: GitHubCorpusBinding) => Promise<T>,
  ) {
    try {
      return await options.accounts.withReadCredential(
        workspaceId,
        userId,
        accountId,
        async credential => {
          const binding = parse(githubCorpusBindingSchema, {
            accountId: credential.accountId,
            accountGeneration: credential.generation,
            githubUserId: credential.identity.id,
            login: credential.identity.login,
          });
          if (
            expected &&
            (expected.githubUserId !== binding.githubUserId || expected.accountGeneration !== binding.accountGeneration)
          )
            throw new GitHubCorpusError('stale-integration');
          return operation(credential, binding);
        },
        expected?.accountGeneration,
      );
    } catch (error) {
      if (error instanceof GitHubCorpusError) throw error;
      if (error instanceof AccessDenied) throw new GitHubCorpusError('not-linked');
      if (error instanceof GitHubAccountError)
        throw new GitHubCorpusError(
          error.code === 'account-disabled'
            ? 'not-configured'
            : error.code === 'account-reconnect-required'
              ? 'reconnect-required'
              : 'transient',
        );
      throw new GitHubCorpusError('transient');
    }
  }
  // Retries transient failures (network, timeout, 5xx) in place; denials, credential and rate-limit failures are final.
  async function retrying<T>(operation: () => Promise<T>) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof GitHubCorpusError) || error.code !== 'transient' || attempt >= requestAttempts)
          throw error;
        // Jittered exponential backoff; a server-provided retry-after is honoured when it is short.
        if (error.retryAfterMs !== null && error.retryAfterMs > retryCapMs) throw error;
        const backoff = Math.min(retryCapMs, retryBaseMs * 2 ** (attempt - 1)) * (0.5 + random() / 2);
        await sleep(Math.max(backoff, error.retryAfterMs ?? 0));
      }
    }
  }
  // Spends the remaining budget evenly until the reset, and pauses before the reserve kept for interactive reads.
  async function pace(key: string) {
    const budget = budgets.get(key);
    if (!budget) return;
    const untilReset = budget.resetAt - Date.now();
    if (untilReset <= 0) {
      budgets.delete(key);
      return;
    }
    const reserve = Math.max(1, Math.ceil(budget.limit * rateReserveRatio));
    if (budget.remaining <= reserve)
      throw new GitHubCorpusError('rate-limited', Math.min(3_600_000, Math.max(1000, untilReset)));
    if (budget.remaining < budget.limit * paceBelowRatio)
      await sleep(Math.min(maxPaceMs, Math.ceil(untilReset / (budget.remaining - reserve))));
  }
  function observeBudget(key: string, headers: Headers) {
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const limit = Number(headers.get('x-ratelimit-limit'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (!headers.has('x-ratelimit-remaining') || !Number.isFinite(remaining) || !Number.isFinite(reset) || reset <= 0)
      return;
    budgets.delete(key);
    budgets.set(key, {
      remaining: Math.max(0, remaining),
      limit: Number.isFinite(limit) && limit > 0 ? limit : Math.max(remaining, 1),
      resetAt: reset * 1000,
    });
    if (budgets.size > 1000) budgets.delete(budgets.keys().next().value as string);
  }
  // Maps transport, credential, rate-limit and server failures before any body is read.
  async function open(
    token: string,
    endpoint: DependencyEndpoint,
    path: string,
    init: { accept?: string; body?: unknown; signal?: AbortSignal } = {},
  ) {
    const budget = budgetKey(token, endpoint);
    await pace(budget);
    let response: Response;
    try {
      response = await observeFetch('github', 'request', fetcher, { endpoint })(`https://api.github.com${path}`, {
        method: init.body === undefined ? 'GET' : 'POST',
        redirect: 'manual',
        signal: init.signal ?? AbortSignal.timeout(limits.requestTimeoutMs),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: init.accept ?? 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'TulipFarm',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw new GitHubCorpusError('transient');
    }
    observeBudget(budget, response.headers);
    const retry = Number(response.headers.get('retry-after'));
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const retryAfterMs =
      Number.isFinite(retry) && response.headers.has('retry-after') && retry >= 0
        ? Math.min(3_600_000, Math.ceil(retry * 1000))
        : Number.isFinite(reset) && reset > 0
          ? Math.min(3_600_000, Math.max(1000, reset * 1000 - Date.now()))
          : null;
    const failure =
      response.status === 401
        ? new GitHubCredentialRejected()
        : response.status === 429 ||
            (response.status === 403 &&
              (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
          ? new GitHubCorpusError('rate-limited', retryAfterMs)
          : response.status >= 500
            ? new GitHubCorpusError('transient', retryAfterMs)
            : null;
    if (failure) {
      if (failure instanceof GitHubCorpusError && failure.code === 'rate-limited') {
        const remaining = response.headers.get('x-ratelimit-remaining');
        log('warn', 'dependency', 'call_failed', {
          'dependency.endpoint': endpoint,
          'http.response.status_code': response.status,
          ...(remaining !== null && Number.isSafeInteger(Number(remaining))
            ? { 'github.ratelimit_remaining': Number(remaining) }
            : {}),
          ...(response.headers.has('retry-after') && Number.isFinite(retry)
            ? { 'github.retry_after_s': Math.ceil(retry) }
            : {}),
          'github.ratelimit_resource': response.headers.get('x-ratelimit-resource') ?? 'none',
        });
      }
      await response.body?.cancel().catch(() => undefined);
      throw failure;
    }
    return response;
  }
  // JSON and other metadata responses are read whole up to `responseBytes`; file content uses `blob` instead.
  function call(
    token: string,
    endpoint: DependencyEndpoint,
    path: string,
    init: { accept?: string; body?: unknown } = {},
  ) {
    return retrying(() => readWhole(token, endpoint, path, init));
  }
  async function readWhole(
    token: string,
    endpoint: DependencyEndpoint,
    path: string,
    init: { accept?: string; body?: unknown },
  ) {
    const response = await open(token, endpoint, path, init);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (Number(response.headers.get('content-length')) > limits.responseBytes)
        throw new GitHubCorpusError('response-too-large');
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limits.responseBytes) throw new GitHubCorpusError('response-too-large');
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (error instanceof GitHubCorpusError) throw error;
      throw new GitHubCorpusError('transient');
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
    const text = () => {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        throw new GitHubCorpusError('invalid-response');
      }
    };
    const json = () => {
      try {
        return JSON.parse(text()) as unknown;
      } catch {
        throw new GitHubCorpusError('invalid-response');
      }
    };
    const next = /<[^>]*>;\s*rel="next"/.test(response.headers.get('link') ?? '');
    return { status: response.status, text, json, next };
  }
  // Streams a raw Git blob. The network time allowed grows with the blob's size, up to `blobTimeoutMs`; time the caller
  // spends between reads does not count, so a caller may process each part before reading the next.
  async function* blob(token: string, repositoryId: string, sha: string, bytes: number) {
    const budget = Math.min(limits.blobTimeoutMs, limits.requestTimeoutMs + Math.ceil(bytes / limits.partBytes) * 1000);
    let waited = 0;
    let controller = new AbortController();
    const timed = async <T>(operation: () => Promise<T>) => {
      const started = Date.now();
      const timer = setTimeout(() => controller.abort(), Math.max(0, budget - waited));
      try {
        return await operation();
      } finally {
        clearTimeout(timer);
        waited += Date.now() - started;
      }
    };
    const response = await retrying(() => {
      controller = new AbortController();
      return timed(() =>
        open(token, 'github-blob', `/repositories/${repositoryId}/git/blobs/${sha}`, {
          accept: 'application/vnd.github.raw',
          signal: controller.signal,
        }),
      );
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubCorpusError([404, 409, 410, 422].includes(response.status) ? 'not-found' : 'invalid-response');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new GitHubCorpusError('invalid-response');
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await timed(() => reader.read());
        } catch {
          throw new GitHubCorpusError('transient');
        }
        if (chunk.done) return;
        yield chunk.value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  async function graphql(token: string, query: string, variables: Record<string, unknown>) {
    const response = await call(token, 'github-graphql', '/graphql', { body: { query, variables } });
    if (response.status === 403 || response.status === 404) throw new GitHubCorpusError('forbidden');
    if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
    const body = parse(
      z.object({
        data: z.unknown().optional(),
        errors: z.array(z.object({ type: z.string().optional() }).passthrough()).optional(),
      }),
      response.json(),
    );
    const types = (body.errors ?? []).map(error => error.type);
    if (types.includes('RATE_LIMITED')) throw new GitHubCorpusError('rate-limited', 60000);
    if (types.includes('NOT_FOUND') || types.includes('FORBIDDEN')) throw new GitHubCorpusError('forbidden');
    if (types.length) throw new GitHubCorpusError('invalid-response');
    return body.data;
  }
  async function byId(token: string, repositoryId: string) {
    const response = await call(
      token,
      'github-repository',
      `/repositories/${parse(githubRepositoryIdSchema, repositoryId, 'invalid-selection')}`,
    );
    if ([301, 302, 307, 403, 404, 410, 451].includes(response.status)) throw new GitHubCorpusError('forbidden');
    if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
    const body = parse(repositorySchema, response.json());
    if (String(body.id) !== repositoryId) throw new GitHubCorpusError('invalid-response');
    if (body.permissions?.pull === false) throw new GitHubCorpusError('forbidden');
    return body;
  }
  async function headCommit(token: string, body: RepositoryBody) {
    if (!body.default_branch) return null;
    const response = await call(
      token,
      'github-head',
      `/repositories/${body.id}/commits/${encodeURIComponent(body.default_branch)}`,
      { accept: 'application/vnd.github.sha' },
    );
    if (response.status === 409 || response.status === 422) return null;
    // The repository itself is readable, so a missing or forbidden branch means the contents permission is missing.
    if (response.status === 403 || response.status === 404) throw new GitHubCorpusError('forbidden');
    if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
    return parse(z.string().regex(/^[a-f0-9]{40,64}$/), response.text().trim());
  }
  function observation(
    repositoryId: string,
    kind: GitHubItemObservation['kind'],
    rest: string,
    title: string,
    canonicalURL: string,
    sourceRevision: string,
    accessedAt: string,
    coverage: GitHubItemObservation['coverage'] = 'supported',
    path?: string,
  ): GitHubItemObservation {
    return {
      nativeId: `${kind}:${repositoryId}:${rest}`,
      repositoryId,
      kind,
      title: title.slice(0, 512),
      canonicalURL,
      sourceRevision,
      accessedAt,
      coverage,
      ...(path === undefined ? {} : { path }),
    };
  }
  const fileURL = (body: RepositoryBody, commit: string, path: string) => {
    const url = `https://github.com/${body.full_name}/blob/${commit}/${encodePath(path)}`;
    return url.length <= 2048 ? url : `https://github.com/${body.full_name}/tree/${commit}`;
  };
  const fileParts = (path: string, size: number) =>
    isGitHubBinaryPath(path) ? 1 : Math.max(1, Math.ceil(size / limits.partBytes));
  function fileObservation(
    body: RepositoryBody,
    commit: string,
    accessedAt: string,
    path: string,
    sha: string,
    part: number,
    parts: number,
  ) {
    return observation(
      String(body.id),
      githubFileKind(path),
      partRest(part, pathRef(path)),
      partTitle(`${body.full_name}: ${path}`, part, parts),
      fileURL(body, commit, path),
      `blob:${sha}`,
      accessedAt,
      'supported',
      path,
    );
  }
  // GitHub can truncate one directory listing. The omission is a visible skip, so partial coverage never reads as complete.
  function omitted(body: RepositoryBody, kind: 'doc' | 'code', commit: string, tree: string, accessedAt: string) {
    return observation(
      String(body.id),
      kind,
      `/truncated/${tree}`,
      `${body.full_name}: a directory with more entries than GitHub lists (tree ${tree} truncated)`,
      `https://github.com/${body.full_name}/tree/${commit}`,
      `tree:${tree}`,
      accessedAt,
      'excluded',
    );
  }
  // A kind the connection cannot read in a repository it can see. The marker is reported, never read, and the
  // repository's other kinds keep syncing.
  function denied(body: RepositoryBody, phase: Phase, accessedAt: string, selection: GitHubCorpusSelection) {
    const kinds: GitHubItemObservation['kind'][] =
      phase === 'docs'
        ? ['doc']
        : phase === 'code'
          ? ['code']
          : phase === 'discussions'
            ? ['discussion']
            : phase === 'commits'
              ? ['commit']
              : [
                  ...(selection.kinds.includes('issues') ? (['issue'] as const) : []),
                  ...(selection.kinds.includes('pulls') ? (['pull'] as const) : []),
                ];
    return kinds.map(kind =>
      observation(
        String(body.id),
        kind,
        '/denied',
        `${body.full_name}: ${phase} not readable with this GitHub connection`,
        `https://github.com/${body.full_name}`,
        'denied',
        accessedAt,
        'denied',
      ),
    );
  }
  // Without a cutoff the whole history is in scope.
  const inWindow = (selection: GitHubCorpusSelection, time: string) =>
    !selection.after || Date.parse(time) >= Date.parse(`${selection.after}T00:00:00Z`);
  async function tree(token: string, body: RepositoryBody, sha: string, recursive = false) {
    const response = await call(
      token,
      'github-tree',
      `/repositories/${body.id}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`,
    );
    if ([404, 409, 422].includes(response.status)) throw new GitHubCorpusError('invalid-cursor');
    if (response.status === 403) throw new GitHubCorpusError('forbidden');
    if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
    return parse(treeSchema, response.json());
  }
  // The whole tree in one response when GitHub returns it complete and small enough; otherwise null, and the tree is walked.
  async function recursiveTree(token: string, body: RepositoryBody, commit: string) {
    try {
      const value = await tree(token, body, commit, true);
      return value.truncated || value.tree.length > limits.recursiveTreeEntries ? null : value.tree;
    } catch (error) {
      if (error instanceof GitHubCorpusError && ['response-too-large', 'invalid-response'].includes(error.code))
        return null;
      throw error;
    }
  }
  // Lists every default-branch file of one kind, in parts. The cursor is `<commit>:<offset>` over the sorted recursive
  // tree, or `<commit>:w<index path>` while walking directories one request at a time.
  async function listFiles(
    token: string,
    body: RepositoryBody,
    phase: 'docs' | 'code',
    state: string,
    accessedAt: string,
    selection: GitHubCorpusSelection,
  ) {
    const kind = phase === 'docs' ? 'doc' : 'code';
    const wanted = (path: string) =>
      githubFileKind(path) === kind && githubPathIndexable(path) && !githubPathOptedOut(selection, path);
    let commit: string;
    let walk: number[] | null = null;
    let offset = 0;
    let part = 1;
    if (!state) {
      const head = await headCommit(token, body);
      if (!head) return { observations: [], nextCursor: nextPhase(selection, phase) };
      commit = head;
    } else {
      const match = /^([a-f0-9]{40,64}):(?:(\d{1,9})|w(\d{1,9}(?:\.\d{1,9}){0,255}))(?:\+([2-9]|[1-9]\d{1,6}))?$/.exec(
        state,
      );
      if (!match) throw new GitHubCorpusError('invalid-cursor');
      commit = match[1] ?? '';
      walk = match[3] === undefined ? null : match[3].split('.').map(Number);
      offset = Number(match[2] ?? 0);
      part = Number(match[4] ?? 1);
    }
    const observations: GitHubItemObservation[] = [];
    // Adds a file's parts from `from`. A file's parts always share one page, however many there are, so the sync reads
    // them all from one download; a page fills only between files. `+<part>` cursors come from earlier listings.
    const add = (path: string, entry: TreeEntry, from: number) => {
      const parts = fileParts(path, entry.size ?? 0);
      for (let next = from; next <= parts; next++)
        observations.push(fileObservation(body, commit, accessedAt, path, entry.sha, next, parts));
    };
    if (!walk) {
      const entries = await recursiveTree(token, body, commit);
      if (entries) {
        const files = entries
          .filter(entry => entry.type === 'blob' && wanted(entry.path))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        for (let index = offset; index < files.length; index++) {
          if (observations.length >= limits.listPageSize)
            return { observations, nextCursor: `${phase}:${commit}:${index}` };
          const entry = files[index] as TreeEntry;
          add(entry.path, entry, index === offset ? part : 1);
        }
        return { observations, nextCursor: nextPhase(selection, phase) };
      }
      walk = [];
      part = 1;
    }
    type Frame = { prefix: string; entries: TreeEntry[]; index: number };
    const stack: Frame[] = [];
    let requests = 0;
    const enter = async (sha: string, prefix: string, index: number, fresh: boolean) => {
      requests++;
      const value = await tree(token, body, sha);
      if (value.truncated && fresh) observations.push(omitted(body, kind, commit, sha, accessedAt));
      stack.push({ prefix, entries: value.tree, index });
    };
    await enter(commit, '', walk[0] ?? 0, walk.length === 0);
    for (let depth = 1; depth < walk.length; depth++) {
      const parent = stack[depth - 1] as Frame;
      const entry = parent.entries[parent.index];
      if (!entry || entry.type !== 'tree') throw new GitHubCorpusError('invalid-cursor');
      await enter(entry.sha, `${parent.prefix}${entry.path}/`, walk[depth] ?? 0, false);
    }
    // Resuming costs one request per directory level; the page budget counts only the requests that make progress.
    const resumed = requests;
    while (stack.length) {
      const top = stack[stack.length - 1] as Frame;
      const entry = top.entries[top.index];
      if (!entry) {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) parent.index++;
        part = 1;
        continue;
      }
      if (observations.length >= limits.listPageSize || requests - resumed >= limits.treeRequestsPerPage) break;
      const path = `${top.prefix}${entry.path}`;
      if (entry.type === 'tree') {
        await enter(entry.sha, `${path}/`, 0, true);
        continue;
      }
      if (entry.type === 'blob' && wanted(path)) add(path, entry, part);
      top.index++;
      part = 1;
    }
    return {
      observations,
      nextCursor: stack.length
        ? `${phase}:${commit}:w${stack.map(frame => frame.index).join('.')}`
        : nextPhase(selection, phase),
    };
  }
  async function listIssues(
    token: string,
    body: RepositoryBody,
    state: string,
    accessedAt: string,
    selection: GitHubCorpusSelection,
    mark: GitHubRepositoryMark | undefined,
  ): Promise<GitHubCorpusPage> {
    // The cursor is `<time>` or `<time>/<page>`: list issues updated at or after `<time>`, a whole second, from that
    // page of GitHub's ascending listing. Moving the time forward keeps page numbers small, so any number of issues
    // can be listed; the page number only steps through a full page of issues that share one update second. A bare
    // page number is a cursor from before this format and restarts the listing.
    const parsed = issueCursor(state);
    const from = parsed ? issueTime(parsed.time - 1) : since(selection, mark?.issues);
    const page = parsed?.page ?? 1;
    const response = await call(
      token,
      'github-issues',
      `/repositories/${body.id}/issues?${new URLSearchParams({ state: 'all', sort: 'updated', direction: 'asc', ...(from ? { since: from } : {}), per_page: String(limits.issuePageSize), page: String(page) })}`,
    );
    // 410 means issues are turned off; 403 and 404 mean the connection cannot read them.
    if (response.status === 410) return { observations: [], nextCursor: nextPhase(selection, 'issues') };
    if (response.status !== 200)
      throw new GitHubCorpusError([403, 404].includes(response.status) ? 'forbidden' : 'invalid-response');
    const issues = parse(z.array(issueSchema).max(100), response.json());
    const second = (issue: Issue) => {
      const time = Date.parse(issue.updated_at);
      if (!Number.isFinite(time)) throw new GitHubCorpusError('invalid-response');
      return Math.floor(time / 1000);
    };
    // GitHub's `since` is asked one second early, so issues from that earlier second are dropped here.
    let kept = parsed ? issues.filter(issue => second(issue) >= parsed.time) : issues;
    let nextCursor = nextPhase(selection, 'issues');
    const last = issues.at(-1);
    if (last && issues.length === limits.issuePageSize) {
      const time = second(last);
      const start = parsed?.time ?? -Infinity;
      if (time > start) {
        // The issues of the page's last second may continue on the next page, so they are all listed from there.
        kept = kept.filter(issue => second(issue) < time);
        nextCursor = `issues:${issueTime(time)}`;
      } else nextCursor = `issues:${issueTime(time)}/${page + 1}`;
    }
    const observations = kept
      .filter(
        issue =>
          selection.kinds.includes(issue.pull_request ? 'pulls' : 'issues') && inWindow(selection, issue.updated_at),
      )
      .flatMap(issue => {
        const parts = commentParts(issue.comments);
        return Array.from({ length: parts }, (_, index) =>
          observation(
            String(body.id),
            issue.pull_request ? 'pull' : 'issue',
            partRest(index + 1, String(issue.number)),
            partTitle(`${body.full_name}#${issue.number}: ${oneLine(issue.title)}`, index + 1, parts),
            issue.html_url,
            `issue:${issue.updated_at}:${issue.comments}`,
            accessedAt,
          ),
        );
      });
    return {
      observations,
      // The listing's start is the next incremental listing's mark; later pages keep the first page's mark.
      ...(parsed ? {} : { mark: { issues: accessedAt } }),
      nextCursor,
    };
  }
  async function listDiscussions(
    token: string,
    body: RepositoryBody,
    state: string,
    accessedAt: string,
    selection: GitHubCorpusSelection,
    mark: GitHubRepositoryMark | undefined,
  ): Promise<GitHubCorpusPage> {
    const data = parse(
      z.object({
        node: z
          .object({
            discussions: z.object({ pageInfo, nodes: z.array(discussionNode).max(limits.listPageSize) }).optional(),
          })
          .nullable(),
      }),
      await graphql(token, DISCUSSIONS, { id: body.node_id, cursor: state || null }),
    );
    const connection = data.node?.discussions;
    if (!connection) return { observations: [], nextCursor: nextPhase(selection, 'discussions') };
    // Discussions arrive most recently updated first, so the listing stops at the first one older than its start.
    const from = since(selection, mark?.discussions);
    const fresh = connection.nodes.filter(node => !from || Date.parse(node.updatedAt) >= Date.parse(from));
    const observations = fresh.flatMap(node => {
      const parts = commentParts(node.comments.totalCount);
      return Array.from({ length: parts }, (_, index) =>
        observation(
          String(body.id),
          'discussion',
          partRest(index + 1, String(node.number)),
          partTitle(`${body.full_name} discussion #${node.number}: ${oneLine(node.title)}`, index + 1, parts),
          node.url,
          `discussion:${node.updatedAt}:${node.comments.totalCount}`,
          accessedAt,
        ),
      );
    });
    const more =
      connection.pageInfo.hasNextPage && fresh.length === connection.nodes.length && connection.pageInfo.endCursor;
    return {
      observations,
      ...(state ? {} : { mark: { discussions: accessedAt } }),
      nextCursor: more ? `discussions:${connection.pageInfo.endCursor}` : nextPhase(selection, 'discussions'),
    };
  }
  const commitObservation = (body: RepositoryBody, commit: Commit, accessedAt: string) =>
    observation(
      String(body.id),
      'commit',
      commit.sha,
      commitTitle(body.full_name, commit),
      `https://github.com/${body.full_name}/commit/${commit.sha}`,
      `commit:${commit.sha}`,
      accessedAt,
    );
  // Every commit reachable from `head`, newest first, pinned to that head so the listing is stable across pages.
  async function commitHistory(
    token: string,
    body: RepositoryBody,
    head: string,
    page: number,
    accessedAt: string,
    selection: GitHubCorpusSelection,
  ): Promise<GitHubCorpusPage> {
    const response = await call(
      token,
      'github-commits',
      `/repositories/${body.id}/commits?${new URLSearchParams({ sha: head, per_page: String(limits.commitPageSize), page: String(page) })}`,
    );
    // An empty repository has no history; a head that no longer exists means the branch moved, so the pass restarts.
    if (response.status === 409) return { observations: [], nextCursor: nextPhase(selection, 'commits') };
    if (response.status === 404 || response.status === 422) throw new GitHubCorpusError('invalid-cursor');
    if (response.status !== 200)
      throw new GitHubCorpusError(response.status === 403 ? 'forbidden' : 'invalid-response');
    const commits = parse(z.array(commitSchema).max(limits.commitPageSize), response.json());
    const observations = commits.map(commit => commitObservation(body, commit, accessedAt));
    return commits.length === limits.commitPageSize
      ? { observations, nextCursor: `commits:${head}:${page + 1}` }
      : { observations, nextCursor: nextPhase(selection, 'commits'), commits: { head, retained: false } };
  }
  // Only the commits `head` added since `base`, oldest first. Returns null when `head` does not simply extend `base`
  // (a force push, or a comparison GitHub cannot make), so the caller lists the whole history instead.
  async function commitsSince(
    token: string,
    body: RepositoryBody,
    base: string,
    head: string,
    page: number,
    accessedAt: string,
    selection: GitHubCorpusSelection,
  ): Promise<GitHubCorpusPage | null> {
    let response;
    try {
      response = await call(
        token,
        'github-compare',
        `/repositories/${body.id}/compare/${base}...${head}?${new URLSearchParams({ per_page: String(limits.commitPageSize), page: String(page) })}`,
      );
    } catch (error) {
      if (
        error instanceof GitHubCorpusError &&
        ['response-too-large', 'transient', 'invalid-response'].includes(error.code)
      )
        return null;
      throw error;
    }
    if (response.status !== 200) return null;
    const compared = compareSchema.safeParse(response.json());
    if (!compared.success || !['ahead', 'identical'].includes(compared.data.status)) return null;
    const observations = compared.data.commits.map(commit => commitObservation(body, commit, accessedAt));
    return compared.data.commits.length === limits.commitPageSize &&
      page * limits.commitPageSize < compared.data.total_commits
      ? { observations, nextCursor: `commits:${base}..${head}:${page + 1}` }
      : { observations, nextCursor: nextPhase(selection, 'commits'), commits: { head, retained: true } };
  }
  async function listCommits(
    token: string,
    body: RepositoryBody,
    state: string,
    accessedAt: string,
    selection: GitHubCorpusSelection,
    history: GitHubListHistory | undefined,
  ): Promise<GitHubCorpusPage> {
    const sha = '[a-f0-9]{40,64}';
    const pageNumber = '[1-9][0-9]{0,6}';
    if (!state) {
      const head = history?.head ?? (await headCommit(token, body));
      if (!head) return { observations: [], nextCursor: nextPhase(selection, 'commits') };
      const base = history?.commitHead;
      if (base === head)
        return { observations: [], nextCursor: nextPhase(selection, 'commits'), commits: { head, retained: true } };
      if (base) {
        const page = await commitsSince(token, body, base, head, 1, accessedAt, selection);
        if (page) return page;
      }
      return commitHistory(token, body, head, 1, accessedAt, selection);
    }
    const since = new RegExp(`^(${sha})\\.\\.(${sha}):(${pageNumber})$`).exec(state);
    if (since) {
      const [, base = '', head = '', page = ''] = since;
      const result = await commitsSince(token, body, base, head, Number(page), accessedAt, selection);
      if (result) return result;
      return commitHistory(token, body, head, 1, accessedAt, selection);
    }
    const full = new RegExp(`^(${sha}):(${pageNumber})$`).exec(state);
    if (!full) throw new GitHubCorpusError('invalid-cursor');
    return commitHistory(token, body, full[1] ?? '', Number(full[2]), accessedAt, selection);
  }
  /**
   * Only the files that changed on the default branch between `base` and `head`, in one page. Returns null when a
   * comparison cannot stand in for a full listing: the base is gone after a force push, history diverged, GitHub cannot
   * list every changed file, or the change does not fit one page.
   */
  async function listChanges(
    token: string,
    body: RepositoryBody,
    base: string,
    head: string,
    accessedAt: string,
    selection: GitHubCorpusSelection,
  ): Promise<{ observations: GitHubItemObservation[]; removed: string[] } | null> {
    let response;
    try {
      response = await call(token, 'github-compare', `/repositories/${body.id}/compare/${base}...${head}?per_page=1`);
    } catch (error) {
      if (error instanceof GitHubCorpusError && ['response-too-large', 'invalid-response'].includes(error.code))
        return null;
      throw error;
    }
    if (response.status !== 200) return null;
    const compared = compareFilesSchema.safeParse(response.json());
    if (!compared.success || compared.data.status !== 'ahead') return null;
    const files = compared.data.files ?? [];
    if (files.length >= compareFileLimit) return null;
    const kinds = new Set(
      phases(selection).flatMap(phase => (phase === 'docs' ? ['doc'] : phase === 'code' ? ['code'] : [])),
    );
    const ref = (path: string) => `${githubFileKind(path)}:${body.id}:${pathRef(path)}`;
    const wanted = (path: string) =>
      kinds.has(githubFileKind(path)) && githubPathIndexable(path) && !githubPathOptedOut(selection, path);
    // Every touched path is listed as removed; the parts observed below are what remains of a changed file.
    const removed = new Set<string>();
    const changed = new Set<string>();
    for (const file of files) {
      if (file.status === 'unchanged') continue;
      if (
        file.previous_filename &&
        file.previous_filename !== file.filename &&
        kinds.has(githubFileKind(file.previous_filename))
      )
        removed.add(ref(file.previous_filename));
      if (kinds.has(githubFileKind(file.filename))) removed.add(ref(file.filename));
      if (file.status !== 'removed' && wanted(file.filename)) changed.add(file.filename);
    }
    const observations: GitHubItemObservation[] = [];
    if (!changed.size) return { observations, removed: [...removed] };
    // One recursive tree read when GitHub returns it whole; otherwise each changed file's directories, one request each.
    const whole = await recursiveTree(token, body, head);
    const directories = new Map<string, Map<string, TreeEntry>>();
    if (whole)
      directories.set('', new Map(whole.filter(entry => entry.type === 'blob').map(entry => [entry.path, entry])));
    let requests = 0;
    const lookup = async (path: string): Promise<TreeEntry | null | 'overflow'> => {
      if (whole) return directories.get('')?.get(path) ?? null;
      const segments = path.split('/');
      let sha = head;
      let prefix = '';
      for (const [index, segment] of segments.entries()) {
        let entries = directories.get(prefix);
        if (!entries) {
          if (++requests > limits.treeRequestsPerPage) return 'overflow';
          const value = await tree(token, body, sha);
          if (value.truncated) return 'overflow';
          entries = new Map(value.tree.map(entry => [entry.path, entry]));
          directories.set(prefix, entries);
        }
        const entry = entries.get(segment);
        if (!entry) return null;
        if (index === segments.length - 1) return entry.type === 'blob' ? entry : null;
        if (entry.type !== 'tree') return null;
        sha = entry.sha;
        prefix = `${prefix}${segment}/`;
      }
      return null;
    };
    for (const path of [...changed].sort()) {
      const entry = await lookup(path);
      if (entry === 'overflow') return null;
      if (!entry) continue;
      const parts = fileParts(path, entry.size ?? 0);
      for (let part = 1; part <= parts; part++)
        observations.push(fileObservation(body, head, accessedAt, path, entry.sha, part, parts));
      if (observations.length > limits.listPageSize) return null;
    }
    return { observations, removed: [...removed] };
  }
  // One commit with every changed file GitHub lists, following GitHub's pages of files up to its 3,000-file cap.
  async function readCommit(token: string, body: RepositoryBody, sha: string, accessedAt: string) {
    const files: GitHubCommitFile[] = [];
    let commit: Commit | null = null;
    let truncation: GitHubCommitFilesTruncation | null = null;
    for (let page = 1; ; page++) {
      let response;
      try {
        response = await call(
          token,
          'github-commit',
          `/repositories/${body.id}/commits/${sha}?${new URLSearchParams({ per_page: String(limits.commitPageSize), page: String(page) })}`,
        );
      } catch (error) {
        // The response carries every file's patch; a commit too large to return is described without its files.
        if (error instanceof GitHubCorpusError && error.code === 'response-too-large') {
          truncation = 'unavailable';
          break;
        }
        throw error;
      }
      if ([404, 409, 410, 422].includes(response.status)) throw new GitHubCorpusError('not-found');
      if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
      const detail = parse(commitDetailSchema, response.json());
      if (detail.sha !== sha) throw new GitHubCorpusError('invalid-response');
      commit ??= detail;
      files.push(...(detail.files ?? []));
      if (files.length >= limits.commitFiles) {
        files.splice(limits.commitFiles);
        truncation = 'file-limit';
        break;
      }
      if (!response.next || !detail.files?.length) break;
    }
    commit ??= await gitCommit(token, body, sha);
    const markdown = serializeGitHubCommit(body.full_name, commit, files, truncation);
    if (Buffer.byteLength(markdown) > limits.markdownBytes) throw new GitHubCorpusError('too-large');
    return { ...commitObservation(body, commit, accessedAt), markdown };
  }
  async function gitCommit(token: string, body: RepositoryBody, sha: string): Promise<Commit> {
    const response = await call(token, 'github-commit', `/repositories/${body.id}/git/commits/${sha}`);
    if ([404, 409, 410, 422].includes(response.status)) throw new GitHubCorpusError('not-found');
    if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
    const found = parse(gitCommitSchema, response.json());
    if (found.sha !== sha) throw new GitHubCorpusError('invalid-response');
    return {
      sha,
      commit: { message: found.message, author: found.author, committer: found.committer },
      author: null,
      committer: null,
      parents: found.parents,
    };
  }
  // One part's page of issue comments; parts follow GitHub's own comment pages, so no comment count is too many.
  async function comments(token: string, repositoryId: string, issue: Issue, part: number) {
    if (!issue.comments) return [];
    const response = await call(
      token,
      'github-comments',
      `/repositories/${repositoryId}/issues/${issue.number}/comments?per_page=${limits.commentsPerPart}&page=${part}`,
    );
    if (response.status !== 200)
      throw new GitHubCorpusError(
        response.status === 404 || response.status === 410 ? 'not-found' : 'invalid-response',
      );
    return parse(z.array(commentSchema).max(limits.commentsPerPart), response.json());
  }
  // One part of a discussion: skips earlier comment pages by cursor, then pages through every reply of its comments.
  async function discussion(token: string, body: RepositoryBody, number: number, part: number) {
    let cursor: string | null = null;
    for (let skipped = 1; skipped < part; skipped++) {
      const info: z.infer<typeof pageInfo> | undefined = parse(
        commentCursorSchema,
        await graphql(token, DISCUSSION_COMMENT_CURSOR, { id: body.node_id, number, after: cursor }),
      ).node?.discussion?.comments.pageInfo;
      if (!info?.hasNextPage || !info.endCursor) throw new GitHubCorpusError('not-found');
      cursor = info.endCursor;
    }
    const data = parse(
      z.object({ node: z.object({ discussion: discussionPageSchema.nullable().optional() }).nullable() }),
      await graphql(token, DISCUSSION, { id: body.node_id, number, after: cursor }),
    );
    const found = data.node?.discussion;
    if (!found) throw new GitHubCorpusError('not-found');
    let bytes = 0;
    const nodes: GitHubDiscussion['comments']['nodes'] = [];
    for (const comment of found.comments.nodes) {
      const replies = [...comment.replies.nodes];
      let info = comment.replies.pageInfo;
      while (info.hasNextPage && info.endCursor) {
        let more;
        try {
          more = parse(
            z.object({
              node: z.object({ replies: z.object({ pageInfo, nodes: z.array(replySchema).max(100) }) }).nullable(),
            }),
            await graphql(token, DISCUSSION_REPLIES, { id: comment.id, after: info.endCursor }),
          );
        } catch (error) {
          // A comment deleted while it is read is a changed source, not a lost repository.
          if (error instanceof GitHubCorpusError && error.code === 'forbidden')
            throw new GitHubCorpusError('source-changed');
          throw error;
        }
        if (!more.node) throw new GitHubCorpusError('source-changed');
        replies.push(...more.node.replies.nodes);
        for (const reply of more.node.replies.nodes) bytes += Buffer.byteLength(reply.body);
        if (bytes > limits.markdownBytes) throw new GitHubCorpusError('too-large');
        info = more.node.replies.pageInfo;
      }
      nodes.push({ ...comment, replies: { nodes: replies } });
    }
    return { ...found, comments: { totalCount: found.comments.totalCount, nodes } };
  }
  async function contentFile(token: string, body: RepositoryBody, commit: string, path: string): Promise<FileRef> {
    const response = await call(
      token,
      'github-content',
      `/repositories/${body.id}/contents/${encodePath(path)}?ref=${commit}`,
    );
    if ([404, 410].includes(response.status)) throw new GitHubCorpusError('not-found');
    if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
    const file = parse(contentSchema, response.json(), 'not-found');
    // GitHub inlines content only for files up to 1 MB; larger files are streamed from the blob.
    const content =
      file.encoding === 'base64' && file.content !== undefined ? Buffer.from(file.content, 'base64') : null;
    return { sha: file.sha, size: file.size, ...(content?.byteLength === file.size ? { content } : {}) };
  }
  // A path too long for its native ID is resolved one directory at a time.
  async function treeFile(token: string, body: RepositoryBody, commit: string, path: string): Promise<FileRef> {
    const names = path.split('/');
    let sha = commit;
    for (const [index, name] of names.entries()) {
      let value;
      try {
        value = await tree(token, body, sha);
      } catch (error) {
        if (error instanceof GitHubCorpusError && error.code === 'invalid-cursor')
          throw new GitHubCorpusError('not-found');
        throw error;
      }
      const entry = value.tree.find(item => item.path === name);
      const last = index === names.length - 1;
      if (!entry || entry.type !== (last ? 'blob' : 'tree')) throw new GitHubCorpusError('not-found');
      if (last) return { sha: entry.sha, size: entry.size ?? 0 };
      sha = entry.sha;
    }
    throw new GitHubCorpusError('not-found');
  }
  // A binary file is indexed by its path and details; an extractor (such as OCR) may supply its text instead.
  async function binaryText(token: string, body: RepositoryBody, path: string, file: FileRef) {
    const mediaType = mediaTypeOf(path);
    const inline = file.content;
    const extracted = options.extractBinary
      ? await options.extractBinary({
          path,
          mediaType,
          size: file.size,
          content: () =>
            inline
              ? (async function* () {
                  yield inline;
                })()
              : blob(token, String(body.id), file.sha, file.size),
        })
      : null;
    if (extracted?.trim()) return decode(Buffer.from(extracted), 'utf-8').trim();
    return `Binary file, ${file.size} bytes, media type ${mediaType}. Content extraction pending OCR; only its path and file details are indexed.`;
  }
  // Reads a file's parts from `first` to its last in one pass over its content: inline when GitHub returned it, else
  // one blob download. Part k covers bytes [(k - 1) × partBytes, k × partBytes), each end moved forward to a line
  // break, so only the bytes from the current part's start to its end's search window are held.
  async function* fileReads(
    token: string,
    body: RepositoryBody,
    kind: 'doc' | 'code',
    path: string,
    first: number,
    accessedAt: string,
  ): AsyncGenerator<GitHubFilePart> {
    const commit = await headCommit(token, body);
    if (!commit) throw new GitHubCorpusError('not-found');
    const file =
      Buffer.byteLength(path) > 1024
        ? await treeFile(token, body, commit, path)
        : await contentFile(token, body, commit, path);
    const parts = fileParts(path, file.size);
    if (first > parts) throw new GitHubCorpusError('not-found');
    const result = (part: number, content: string): GitHubFilePart => {
      const base = fileObservation(body, commit, accessedAt, path, file.sha, part, parts);
      const markdown = `# ${body.full_name}: ${path}${parts > 1 ? ` (part ${part} of ${parts})` : ''}\n\nGitHub repository ${body.full_name} (ID ${body.id}), file \`${path.replaceAll('`', '')}\` at commit ${commit} (blob ${file.sha})${parts > 1 ? `, part ${part} of ${parts}` : ''}.\n\n---\n\n${content}\n`;
      if (Buffer.byteLength(markdown) > limits.markdownBytes)
        return { nativeId: base.nativeId, error: new GitHubCorpusError('too-large') };
      return { nativeId: base.nativeId, read: { ...base, markdown } };
    };
    // A binary file has one placeholder part; a file found binary only by its content has no readable later parts.
    const binary = async function* (): AsyncGenerator<GitHubFilePart> {
      if (first === 1) yield result(1, await binaryText(token, body, path, file));
      for (let part = Math.max(2, first); part <= parts; part++)
        yield {
          nativeId: fileObservation(body, commit, accessedAt, path, file.sha, part, parts).nativeId,
          error: new GitHubCorpusError('unsupported'),
        };
    };
    if (isGitHubBinaryPath(path)) return yield* binary();
    const inline = file.content;
    const source = inline
      ? (async function* () {
          yield inline;
        })()
      : blob(token, String(body.id), file.sha, file.size);
    const head = new Uint8Array(Math.min(sniffBytes, file.size));
    let encoding: Encoding | null = null;
    // `window` holds the bytes from `offset` to `received`; `from` is where the next part starts.
    let window: Uint8Array = new Uint8Array(0);
    let offset = 0;
    let received = 0;
    let from = 0;
    let part = 1;
    const needed = (k: number) =>
      k === parts ? file.size : Math.min(file.size, k * limits.partBytes + boundarySearchBytes);
    const ready = function* (): Generator<GitHubFilePart> {
      while (encoding && encoding !== 'binary' && part <= parts && received >= needed(part)) {
        const to = part === parts ? file.size : boundary(window, offset, part * limits.partBytes, file.size, encoding);
        if (part >= first) {
          const text = decode(window.subarray(from - offset, Math.max(from, to) - offset), encoding)
            .replace(/^\s*\n/, '')
            .trimEnd();
          yield result(
            part,
            !text
              ? parts > 1
                ? '_No text content in this part._'
                : '_No text content._'
              : kind === 'code'
                ? `${fence(text)}\n${text}\n${fence(text)}`
                : text,
          );
        }
        from = Math.max(from, to);
        part++;
        window = window.subarray(from - offset);
        offset = from;
      }
    };
    const sniffed = () => {
      if (encoding || received < head.byteLength) return;
      const found = sniff(head);
      encoding = found.encoding;
      from = found.bom;
    };
    for await (const chunk of source) {
      if (received < head.byteLength) head.set(chunk.subarray(0, head.byteLength - received), received);
      const merged = new Uint8Array(window.byteLength + chunk.byteLength);
      merged.set(window);
      merged.set(chunk, window.byteLength);
      window = merged;
      received += chunk.byteLength;
      sniffed();
      if (encoding === 'binary' || part > parts) break;
      yield* ready();
      if (part > parts) break;
    }
    sniffed();
    if (encoding === 'binary') return yield* binary();
    yield* ready();
    if (part <= parts) throw new GitHubCorpusError('source-changed');
  }
  async function readFile(
    token: string,
    body: RepositoryBody,
    kind: 'doc' | 'code',
    path: string,
    part: number,
    accessedAt: string,
  ): Promise<GitHubItemRead> {
    for await (const read of fileReads(token, body, kind, path, part, accessedAt)) {
      if ('error' in read) throw read.error;
      return read.read;
    }
    throw new GitHubCorpusError('source-changed');
  }
  // Checks that a native ID names an item the selection covers, and resolves a file's full path.
  function target(repositoryId: string, nativeId: string, input: GitHubCorpusSelection, path?: string | null) {
    const selection = parse(githubCorpusSelectionSchema, input, 'invalid-selection');
    const id = native(nativeId, repositoryId);
    const { kind } = id;
    if (
      !selection.kinds.includes(
        kind === 'doc'
          ? 'docs'
          : kind === 'code'
            ? 'code'
            : kind === 'issue'
              ? 'issues'
              : kind === 'pull'
                ? 'pulls'
                : kind === 'discussion'
                  ? 'discussions'
                  : 'commits',
      )
    )
      throw new GitHubCorpusError('outside-selection');
    if (id.marker) throw new GitHubCorpusError('not-found');
    let file: string | null = null;
    if (kind === 'doc' || kind === 'code') {
      file = id.hash ? (path ?? null) : id.ref;
      if (file === null || (id.hash && (Buffer.byteLength(file) <= 1024 || hashPath(file) !== id.hash)))
        throw new GitHubCorpusError('not-found');
      if (githubFileKind(file) !== kind || !githubPathIndexable(file) || githubPathOptedOut(selection, file))
        throw new GitHubCorpusError('outside-selection');
    }
    return { selection, id, kind, file };
  }
  return {
    async discover(workspaceId, userId, accountId, cursor) {
      const page = cursor === undefined ? 1 : Number(parse(githubCorpusCursorTokenSchema, cursor, 'invalid-cursor'));
      if (!Number.isInteger(page) || page < 1 || page > 100) throw new GitHubCorpusError('invalid-cursor');
      return withAccount(workspaceId, userId, accountId, null, async (credential, binding) => {
        const response = await call(
          credential.accessToken,
          'github-repositories',
          `/user/repos?${new URLSearchParams({ per_page: '50', page: String(page), sort: 'full_name', affiliation: 'owner,collaborator,organization_member' })}`,
        );
        if (response.status !== 200)
          throw new GitHubCorpusError(response.status === 403 ? 'forbidden' : 'invalid-response');
        const items = parse(z.array(z.unknown()).max(100), response.json());
        const repositories = items.flatMap(item => {
          const parsed = repositorySchema.safeParse(item);
          return parsed.success && parsed.data.permissions?.pull !== false ? [repository(parsed.data)] : [];
        });
        return {
          binding,
          items: repositories,
          nextCursor: items.length === 50 ? String(page + 1) : null,
        };
      });
    },
    async inspectSelection(workspaceId, userId, accountId, input) {
      const selection = parse(githubCorpusSelectionSchema, input, 'invalid-selection');
      return withAccount(workspaceId, userId, accountId, null, async (credential, binding) => {
        const repositories: GitHubRepository[] = [];
        for (const name of selection.repositories) {
          const [owner = '', repo = ''] = name.split('/');
          const response = await call(
            credential.accessToken,
            'github-repository-selection',
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
          );
          // A redirect means the repository was renamed or transferred; the caller must select its current name.
          if ([301, 302, 307].includes(response.status)) throw new GitHubCorpusError('invalid-selection');
          if ([403, 404, 410, 451].includes(response.status)) throw new GitHubCorpusError('forbidden');
          if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
          const body = parse(repositorySchema, response.json());
          if (body.full_name.toLowerCase() !== name.toLowerCase()) throw new GitHubCorpusError('invalid-selection');
          if (body.permissions?.pull === false) throw new GitHubCorpusError('forbidden');
          const value = repository(body);
          repositories.push(value);
        }
        const [first] = repositories;
        if (!first) throw new GitHubCorpusError('invalid-selection');
        return {
          binding,
          repositories,
          title: repositories.length === 1 ? first.fullName : `${first.fullName} and ${repositories.length - 1} more`,
        };
      });
    },
    async access(workspaceId, userId, expected, repositoryId) {
      return withAccount(workspaceId, userId, expected.accountId, expected, async credential => {
        const accessedAt = new Date().toISOString();
        let body: RepositoryBody;
        try {
          body = await byId(credential.accessToken, repositoryId);
        } catch (error) {
          if (error instanceof GitHubCorpusError && error.code === 'forbidden')
            return {
              repositoryId,
              fullName: 'unknown/unknown',
              visibility: 'private' as const,
              title: repositoryId,
              accessedAt,
              readable: false,
            };
          throw error;
        }
        const value = repository(body);
        return { ...value, accessedAt, readable: true };
      });
    },
    async list(workspaceId, userId, expected, repositoryId, input, cursor, history) {
      const selection = parse(githubCorpusSelectionSchema, input, 'invalid-selection');
      if (cursor !== null) cursor = parse(githubCorpusCursorTokenSchema, cursor, 'invalid-cursor');
      const known = history?.head ? parse(z.string().regex(shaPattern), history.head, 'invalid-cursor') : undefined;
      return withAccount(workspaceId, userId, expected.accountId, expected, async credential => {
        const token = credential.accessToken;
        const body = await byId(token, repositoryId);
        const accessedAt = new Date().toISOString();
        const value = cursor ?? `${phases(selection)[0] ?? 'docs'}:`;
        const split = value.indexOf(':');
        const phase = value.slice(0, split);
        const state = value.slice(split + 1);
        if (split < 0 || !(phases(selection) as string[]).includes(phase))
          throw new GitHubCorpusError('invalid-cursor');
        const mark = history?.mark;
        let page: GitHubCorpusPage;
        try {
          // The first file listing records the head it reads. A later listing with that mark skips the files when the
          // head is unchanged and otherwise lists only the files a comparison reports, falling back to every file.
          if (filePhase(phase) && !state) {
            const head = known ?? (await headCommit(token, body));
            if (!head) page = { observations: [], nextCursor: afterFiles(selection) };
            else if (phases(selection)[0] !== phase)
              page = await listFiles(token, body, phase, `${head}:0`, accessedAt, selection);
            else if (mark?.head === head)
              page = { observations: [], nextCursor: afterFiles(selection), mark: { head } };
            else {
              const changes = mark?.head
                ? await listChanges(token, body, mark.head, head, accessedAt, selection)
                : null;
              page = changes
                ? { ...changes, nextCursor: afterFiles(selection), mark: { head } }
                : {
                    ...(await listFiles(token, body, phase, `${head}:0`, accessedAt, selection)),
                    mark: { head },
                    // Files removed since the mark are found only by a full pass.
                    ...(mark?.head ? { reconcile: true } : {}),
                  };
            }
          } else
            page =
              phase === 'docs' || phase === 'code'
                ? await listFiles(token, body, phase, state, accessedAt, selection)
                : phase === 'issues'
                  ? await listIssues(token, body, state, accessedAt, selection, mark)
                  : phase === 'discussions'
                    ? await listDiscussions(token, body, state, accessedAt, selection, mark)
                    : await listCommits(token, body, state, accessedAt, selection, history);
        } catch (error) {
          if (!(error instanceof GitHubCorpusError) || error.code !== 'forbidden') throw error;
          page = {
            observations: denied(body, phase as Phase, accessedAt, selection),
            nextCursor: nextPhase(selection, phase as Phase),
          };
        }
        return {
          observations: page.observations,
          nextCursor: page.nextCursor ? parse(githubCorpusCursorTokenSchema, page.nextCursor) : null,
          ...(page.commits ? { commits: page.commits } : {}),
          ...(page.removed?.length ? { removed: page.removed } : {}),
          ...(page.mark ? { mark: page.mark } : {}),
          ...(page.reconcile ? { reconcile: true } : {}),
        };
      });
    },
    async read(workspaceId, userId, expected, repositoryId, nativeId, input, path): Promise<GitHubItemRead> {
      const { selection, id, kind, file } = target(repositoryId, nativeId, input, path);
      return withAccount(workspaceId, userId, expected.accountId, expected, async credential => {
        const token = credential.accessToken;
        const accessedAt = new Date().toISOString();
        const body = await byId(token, repositoryId);
        if (file !== null && (kind === 'doc' || kind === 'code'))
          return readFile(token, body, kind, file, id.part, accessedAt);
        if (kind === 'commit') return readCommit(token, body, id.ref, accessedAt);
        if (kind === 'discussion') {
          const found = await discussion(token, body, Number(id.ref), id.part);
          if (!inWindow(selection, found.updatedAt)) throw new GitHubCorpusError('outside-selection');
          const parts = commentParts(found.comments.totalCount);
          if (id.part > parts) throw new GitHubCorpusError('not-found');
          const markdown = serializeGitHubDiscussion(body.full_name, found, id.part);
          if (Buffer.byteLength(markdown) > limits.markdownBytes) throw new GitHubCorpusError('too-large');
          return {
            ...observation(
              repositoryId,
              'discussion',
              partRest(id.part, id.ref),
              partTitle(`${body.full_name} discussion #${found.number}: ${oneLine(found.title)}`, id.part, parts),
              found.url,
              `discussion:${found.updatedAt}:${found.comments.totalCount}`,
              accessedAt,
            ),
            markdown,
          };
        }
        const response = await call(token, 'github-issue', `/repositories/${body.id}/issues/${id.ref}`);
        // Deleted (410), missing (404) and transferred (301) issues no longer belong to this repository.
        if ([301, 302, 307, 404, 410].includes(response.status)) throw new GitHubCorpusError('not-found');
        if (response.status !== 200) throw new GitHubCorpusError('invalid-response');
        const issue = parse(issueSchema, response.json());
        if ((issue.pull_request ? 'pull' : 'issue') !== kind || String(issue.number) !== id.ref)
          throw new GitHubCorpusError('not-found');
        if (!inWindow(selection, issue.updated_at)) throw new GitHubCorpusError('outside-selection');
        const parts = commentParts(issue.comments);
        if (id.part > parts) throw new GitHubCorpusError('not-found');
        const markdown = serializeGitHubIssue(
          body.full_name,
          issue,
          await comments(token, repositoryId, issue, id.part),
          id.part,
        );
        if (Buffer.byteLength(markdown) > limits.markdownBytes) throw new GitHubCorpusError('too-large');
        return {
          ...observation(
            repositoryId,
            kind,
            partRest(id.part, id.ref),
            partTitle(`${body.full_name}#${issue.number}: ${oneLine(issue.title)}`, id.part, parts),
            issue.html_url,
            `issue:${issue.updated_at}:${issue.comments}`,
            accessedAt,
          ),
          markdown,
        };
      });
    },
    async readFile(workspaceId, userId, expected, repositoryId, nativeId, input, path, accept) {
      const { id, kind, file } = target(repositoryId, nativeId, input, path);
      if (file === null || (kind !== 'doc' && kind !== 'code')) throw new GitHubCorpusError('not-found');
      await withAccount(workspaceId, userId, expected.accountId, expected, async credential => {
        const token = credential.accessToken;
        const body = await byId(token, repositoryId);
        for await (const part of fileReads(token, body, kind, file, id.part, new Date().toISOString()))
          if ((await accept(part)) === false) break;
      });
    },
  };
}

const unconfigured = async (): Promise<never> => {
  throw new GitHubCorpusError('not-configured');
};
export const unconfiguredGitHubCorpusProvider: GitHubCorpusProvider = {
  discover: unconfigured,
  inspectSelection: unconfigured,
  access: unconfigured,
  list: unconfigured,
  read: unconfigured,
};

// Reuses the personal GitHub OAuth configuration and integration credential keys. Missing configuration reports not-configured instead of blocking startup.
export function githubCorpusFromEnvironment(options: {
  runtime: AccountRuntime;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
}): GitHubCorpusProvider {
  const env = options.env ?? process.env;
  try {
    const configuration = githubConfiguration(env);
    if (!configuration) return unconfiguredGitHubCorpusProvider;
    const accounts = createGitHubAccounts({
      runtime: options.runtime,
      configuration,
      keyring: integrationCredentialKeyring(env),
    });
    return createGitHubCorpusProvider({ accounts, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  } catch {
    return unconfiguredGitHubCorpusProvider;
  }
}
