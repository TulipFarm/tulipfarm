import { AdapterDispatchError } from "@tulipfarm/tool-broker";
import { classifyHttpFailure } from "../../http";
import {
  type Arguments,
  filesArg,
  type GitHubApi,
  githubEffectMarker,
  list,
  record,
  stringArg,
} from "./shared";

/** How far back `findCommitByMarker` looks for a redelivered effect's own earlier push. */
const MARKER_SEARCH_PER_PAGE = 100;
const MARKER_SEARCH_MAX_PAGES = 5;

export function repositoryOutput(
  owner: string,
  name: string,
  repo: Record<string, unknown>
): unknown {
  return {
    repository: `${owner}/${name}`,
    htmlUrl: String(repo.html_url),
    private: repo.private === true,
    defaultBranch: String(repo.default_branch ?? "main"),
  };
}

export function pushOutput(
  repository: string,
  branch: string,
  commit: Record<string, unknown>
): unknown {
  const sha = String(commit.sha);
  return { repository, branch, sha, htmlUrl: `https://github.com/${repository}/commit/${sha}` };
}

/**
 * A repo may or may not exist yet, so this reads the provider directly rather than through
 * `call()` — a 404 here is the expected "not created" case, not a failure to surface.
 */
export async function lookupRepository(
  api: GitHubApi,
  owner: string,
  name: string,
  credential: string
): Promise<Record<string, unknown> | undefined> {
  const response = await api.http.send(
    { method: "GET", path: `/repos/${owner}/${name}` },
    credential
  );
  if (response.status === 404) return undefined;
  const failure = classifyHttpFailure(response, false);
  if (failure !== null)
    throw new AdapterDispatchError(failure.phase, failure.code, failure.retryable);
  return record(response.body);
}

export async function createRepository(
  api: GitHubApi,
  source: Arguments,
  credential: string
): Promise<unknown> {
  const owner = stringArg(source, "owner");
  const name = stringArg(source, "name");

  // Read before write: a redelivered effect must return the repo it already created.
  const existing = await lookupRepository(api, owner, name, credential);
  if (existing !== undefined) return repositoryOutput(owner, name, existing);

  const description = typeof source.description === "string" ? source.description : undefined;
  const isPrivate = source.private !== false;

  const response = await api.call(
    {
      method: "POST",
      path: `/orgs/${owner}/repos`,
      body: { name, description, private: isPrivate },
    },
    credential,
    true
  );
  return repositoryOutput(owner, name, record(response.body));
}

/** Bounded marker lookup for duplicate pushes; not found means the effect likely never pushed. */
export async function findCommitByMarker(
  api: GitHubApi,
  repository: string,
  branch: string,
  marker: string,
  credential: string
): Promise<Record<string, unknown> | undefined> {
  for (let page = 1; page <= MARKER_SEARCH_MAX_PAGES; page += 1) {
    const response = await api.call(
      {
        method: "GET",
        path: `/repos/${repository}/commits`,
        query: { sha: branch, per_page: String(MARKER_SEARCH_PER_PAGE), page: String(page) },
      },
      credential,
      false
    );
    const commits = list(response.body).map((entry) => record(entry));
    const match = commits.find((entry) =>
      String(record(entry.commit).message ?? "").includes(marker)
    );
    if (match !== undefined) return match;
    if (commits.length < MARKER_SEARCH_PER_PAGE) return undefined;
  }
  return undefined;
}

export async function pushCommit(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  idempotencyKey: string,
  credential: string
): Promise<unknown> {
  const branch = stringArg(source, "branch");
  const marker = githubEffectMarker(idempotencyKey);

  // Read before write: a redelivered effect must return the commit it already pushed.
  const existing = await findCommitByMarker(api, repository, branch, marker, credential);
  if (existing !== undefined) return pushOutput(repository, branch, existing);

  const refResponse = await api.call(
    { method: "GET", path: `/repos/${repository}/git/ref/heads/${branch}` },
    credential,
    false
  );
  const headSha = String(record(record(refResponse.body).object).sha);

  const headCommitResponse = await api.call(
    { method: "GET", path: `/repos/${repository}/git/commits/${headSha}` },
    credential,
    false
  );
  const baseTreeSha = String(record(record(headCommitResponse.body).tree).sha);

  const files = filesArg(source, "files");
  const blobShas = await Promise.all(
    files.map(async (file) => {
      const blobResponse = await api.call(
        {
          method: "POST",
          path: `/repos/${repository}/git/blobs`,
          body: { content: file.content, encoding: "utf-8" },
        },
        credential,
        true
      );
      return String(record(blobResponse.body).sha);
    })
  );

  const treeResponse = await api.call(
    {
      method: "POST",
      path: `/repos/${repository}/git/trees`,
      body: {
        base_tree: baseTreeSha,
        tree: files.map((file, index) => ({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: blobShas[index],
        })),
      },
    },
    credential,
    true
  );
  const newTreeSha = String(record(treeResponse.body).sha);

  const newCommitResponse = await api.call(
    {
      method: "POST",
      path: `/repos/${repository}/git/commits`,
      body: {
        message: `${stringArg(source, "message")}\n\n${marker}`,
        tree: newTreeSha,
        parents: [headSha],
      },
    },
    credential,
    true
  );
  const newCommit = record(newCommitResponse.body);

  await api.call(
    {
      method: "PATCH",
      path: `/repos/${repository}/git/refs/heads/${branch}`,
      body: { sha: newCommit.sha, force: false },
    },
    credential,
    true
  );

  return pushOutput(repository, branch, newCommit);
}
