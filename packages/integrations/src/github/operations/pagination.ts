import { PaginationBoundError } from "../../http";
import { type GitHubApi, list, record } from "./shared";

/** A bounded prefix can prove presence, never absence. Never follow provider-supplied URLs. */
export async function findGitHubEntry(
  api: GitHubApi,
  path: string,
  query: Readonly<Record<string, string>>,
  credential: string,
  matches: (entry: Record<string, unknown>) => boolean
): Promise<Record<string, unknown> | undefined> {
  for (let page = 1; page <= 10; page += 1) {
    const response = await api.call(
      { method: "GET", path, query: { ...query, per_page: "100", page: String(page) } },
      credential,
      false
    );
    const entries = list(response.body).map(record);
    const match = entries.find(matches);
    if (match !== undefined) return match;
    const link = Object.entries(response.headers).find(
      ([name]) => name.toLowerCase() === "link"
    )?.[1];
    const hasNext = link !== undefined && /;\s*rel\s*=\s*"?next"?(?:\s|,|;|$)/i.test(link);
    if (!hasNext && entries.length < 100) return undefined;
  }
  throw new PaginationBoundError("max_pages");
}
