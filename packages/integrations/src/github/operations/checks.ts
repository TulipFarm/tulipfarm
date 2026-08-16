import { type Arguments, type GitHubApi, numberArg, record } from "./shared";

export async function readCheckRun(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  credential: string
): Promise<unknown> {
  const checkRunId = numberArg(source, "checkRunId");
  const response = await api.call(
    { method: "GET", path: `/repos/${repository}/check-runs/${checkRunId}` },
    credential,
    false
  );
  const checkRun = record(response.body);
  return {
    id: Number(checkRun.id),
    name: String(checkRun.name),
    status: String(checkRun.status),
    conclusion: typeof checkRun.conclusion === "string" ? checkRun.conclusion : null,
    htmlUrl: String(checkRun.html_url),
  };
}
