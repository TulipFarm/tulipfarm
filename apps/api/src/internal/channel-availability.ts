import type { SoulLoader } from "@tulipfarm/soul";

/** Legacy Slack retains credentials on disconnect; admission must consult the live Soul. */
export function isChannelEnabled(soul: SoulLoader | undefined, provider: string): boolean {
  return provider !== "slack" || soul?.integrations.get("slack")?.connection?.enabled === true;
}
