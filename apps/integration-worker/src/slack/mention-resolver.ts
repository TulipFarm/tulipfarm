import {
  classifyHttpFailure,
  type IntegrationHttpPort,
  type SlackMentionResolverPort,
} from "@tulipfarm/integrations";

interface SlackUsersInfoResponse {
  ok?: boolean;
  user?: {
    name?: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
}

function displayNameFrom(body: SlackUsersInfoResponse): string | undefined {
  const user = body.user;
  if (!body.ok || !user) return undefined;
  return user.profile?.display_name || user.profile?.real_name || user.real_name || user.name;
}

/**
 * `SlackMentionResolverPort` backed by `users.info`, reusing the same `IntegrationHttpPort` +
 * bot token already leased for delivery. Best-effort: any failure resolves to `undefined` rather
 * than throwing, so a Slack API hiccup never blocks message ingestion. Cached per-instance
 * (one instance per business boot) since the same person is commonly mentioned repeatedly.
 */
export function slackUserDirectoryMentionResolver(
  http: IntegrationHttpPort,
  credential: string,
  log: { warn: (message: string, error?: unknown) => void }
): SlackMentionResolverPort {
  const cache = new Map<string, string | undefined>();

  return {
    async resolveDisplayName(userId: string): Promise<string | undefined> {
      if (cache.has(userId)) return cache.get(userId);

      let name: string | undefined;
      try {
        const response = await http.send(
          { method: "GET", path: "/users.info", query: { user: userId } },
          credential
        );
        const failure = classifyHttpFailure(response, false);
        if (failure) {
          log.warn(`slack users.info failed for ${userId}: ${failure.code}`);
        } else {
          name = displayNameFrom(response.body as SlackUsersInfoResponse);
        }
      } catch (err) {
        log.warn(`slack users.info threw for ${userId}`, err);
      }

      cache.set(userId, name);
      return name;
    },
  };
}
