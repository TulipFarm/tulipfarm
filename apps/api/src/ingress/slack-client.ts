/**
 * Minimal fetch-based Slack Web API client for the ingress path (identity lookup, bot-self
 * detection, and the fallback reply channel). Deliberately independent of the integration's MCP
 * server: the MCP process exposes whatever tools its package ships, while ingress needs these
 * three calls with a stable contract. Bot token comes from the integration's connection env.
 */

const SLACK_API_BASE = "https://slack.com/api";

interface SlackApiEnvelope {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string
  ) {
    super(`slack ${method} failed: ${code}`);
    this.name = "SlackApiError";
  }
}

export interface SlackAuthInfo {
  /** The bot's own user id (events from this user are ignored — bot-loop prevention). */
  botUserId: string;
  teamId: string;
}

export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async call(method: string, body?: Record<string, unknown>): Promise<SlackApiEnvelope> {
    const res = await this.fetchImpl(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as SlackApiEnvelope;
    if (!data.ok) throw new SlackApiError(method, data.error ?? "unknown_error");
    return data;
  }

  async authTest(): Promise<SlackAuthInfo> {
    const data = await this.call("auth.test");
    return { botUserId: String(data.user_id ?? ""), teamId: String(data.team_id ?? "") };
  }

  /** The user's profile email, or null when Slack withholds it (missing scope, deleted user). */
  async userEmail(userId: string): Promise<string | null> {
    const data = await this.call("users.info", { user: userId });
    const user = data.user as { profile?: { email?: unknown } } | undefined;
    const email = user?.profile?.email;
    return typeof email === "string" && email.length > 0 ? email : null;
  }

  async postMessage(args: { channel: string; text: string; threadTs?: string }): Promise<void> {
    await this.call("chat.postMessage", {
      channel: args.channel,
      text: args.text,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    });
  }
}
