import type { AuthStepOutcome } from "./auth-broker";
import { AuthBrokerError } from "./auth-broker";

/** Verify which GitHub account issued a personal OAuth token before recording its subject. */
export async function resolveGitHubPrincipalSubject(
  outcome: AuthStepOutcome,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<string> {
  const failure = (message: string) => {
    const error = new AuthBrokerError("exchange_failed", message, outcome.slug);
    error.webUrl = outcome.webUrl;
    return error;
  };
  const step = outcome.oauth2Step;
  const token = step === undefined ? undefined : outcome.env[step.token_env];
  if (token === undefined) {
    throw failure("GitHub returned no personal access token");
  }

  let response: Response;
  try {
    response = await fetchImpl("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw failure("GitHub could not verify the connected account");
  }
  if (!response.ok) {
    throw failure("GitHub rejected the connected account");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw failure("GitHub returned an invalid account response");
  }
  const login = (body as { login?: unknown } | null)?.login;
  if (typeof login !== "string" || login.trim() === "") {
    throw failure("GitHub returned no account login");
  }
  return login;
}
