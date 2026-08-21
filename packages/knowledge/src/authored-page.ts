/**
 * Authoring a standalone Page — the write behind `create_knowledge_page` and
 * `POST /knowledge/pages`, as distinct from `writePage`, which authors into a Space the caller
 * names.
 *
 * A standalone Page still has to be *placed* and *granted*, which is the whole reason this is not
 * a bare insert: the lexical arm of retrieval only considers Pages carrying a Space and a path, no
 * Space listing can show a Page that is in no Space, the Page detail route has no live Page to
 * render without a path, and the read gate denies a Page carrying no ACL entry — to its author
 * included.
 */

import { randomUUID } from "node:crypto";
import type { KnowledgeServiceDeps } from "./service";
import { afterWrite } from "./service-indexing";
import { createSpace, grantBlanketRead } from "./service-spaces";
import type { KnowledgePage } from "./types";

/** The Space a Page authored without one of its own lands in. Made on first use; never restricted. */
export const NOTES_SPACE_NAME = "Notes";

/** What {@link createAuthoredPage} needs; the service's own `CreatePageInput`. */
interface AuthoredPageInput {
  title: string;
  content: string;
  domain?: string | null;
  tags?: string[];
  alwaysLoadForAgents?: boolean;
}

/**
 * The Space for Pages authored outside any Space, made if it is not there yet.
 *
 * Left unrestricted on purpose: grants intersect down the Space-to-Page chain, so an unrestricted
 * Space imposes no ceiling and each Page's own grants stay the whole of its authorization.
 *
 * @returns `null` when OKF is unwired, which leaves the Page flat rather than failing the write.
 */
async function notesSpaceId(deps: KnowledgeServiceDeps): Promise<string | null> {
  const spaces = deps.spaces;
  if (!spaces) return null;
  const existing = await spaces.getByName(NOTES_SPACE_NAME);
  if (existing) return existing._id;
  const created = await createSpace(deps, {
    name: NOTES_SPACE_NAME,
    description: "Pages authored on their own, outside any other space.",
  });
  if (created.ok) return created.space._id;
  // Lost the race with a concurrent create: whoever won already made it.
  return created.reason === "name_taken"
    ? ((await spaces.getByName(NOTES_SPACE_NAME))?._id ?? null)
    : null;
}

/** `Password Reset FAQ` -> `password-reset-faq`. A title with no slug characters falls back. */
function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "page";
}

/**
 * A path no Page in `spaceId` already holds. Paths are unique per Space, so a second "Password
 * Reset FAQ" has to land beside the first rather than overwrite it.
 */
async function freePath(
  deps: KnowledgeServiceDeps,
  spaceId: string,
  title: string
): Promise<string> {
  const base = slugifyTitle(title);
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    if (!(await deps.pages.getBySpacePath(spaceId, candidate))) return candidate;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}

/** Author a standalone Page, placed in {@link NOTES_SPACE_NAME} and readable Business-wide. */
export async function createAuthoredPage(
  deps: KnowledgeServiceDeps,
  input: AuthoredPageInput
): Promise<KnowledgePage> {
  const now = new Date();
  const id = randomUUID();
  const spaceId = await notesSpaceId(deps);
  const page: KnowledgePage = {
    _id: id,
    title: input.title,
    content: input.content,
    plainText: input.content.trim(),
    source: "authored",
    sourceId: id,
    domain: input.domain ?? null,
    tags: input.tags ?? [],
    active: true,
    alwaysLoadForAgents: input.alwaysLoadForAgents ?? false,
    version: 1,
    ...(spaceId === null ? {} : { spaceId, path: await freePath(deps, spaceId, input.title) }),
    createdAt: now,
    updatedAt: now,
  };
  await deps.pages.insert(page);
  // Before the index, never after: a Page indexed while it still carries no grant is a Page the
  // gate denies to everyone, its author included.
  await grantBlanketRead(deps, id);
  await afterWrite(deps, page);
  return page;
}
