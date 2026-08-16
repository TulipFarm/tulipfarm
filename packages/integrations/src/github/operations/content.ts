import { type Arguments, type GitHubApi, list, record, stringArg } from "./shared";

export async function readContent(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  credential: string
): Promise<unknown> {
  const path = stringArg(source, "path");
  const ref = typeof source.ref === "string" ? source.ref : undefined;
  const response = await api.call(
    {
      method: "GET",
      path: `/repos/${repository}/contents/${path}`,
      query: ref ? { ref } : undefined,
    },
    credential,
    false
  );
  const entry = record(response.body);
  return {
    repository,
    path: String(entry.path),
    sha: String(entry.sha),
    content: typeof entry.content === "string" ? entry.content : "",
    encoding: typeof entry.encoding === "string" ? entry.encoding : "base64",
    htmlUrl: String(entry.html_url),
  };
}

export async function listContent(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  credential: string
): Promise<unknown> {
  const path = typeof source.path === "string" ? source.path : "";
  const ref = typeof source.ref === "string" ? source.ref : undefined;
  const response = await api.call(
    {
      method: "GET",
      path: `/repos/${repository}/contents/${path}`,
      query: ref ? { ref } : undefined,
    },
    credential,
    false
  );
  const entries = list(response.body).map((entry) => {
    const item = record(entry);
    return {
      name: String(item.name),
      path: String(item.path),
      type: String(item.type),
      sha: String(item.sha),
      htmlUrl: String(item.html_url),
    };
  });
  return { repository, path, entries };
}
