import type { ConversationMode } from "@tulipfarm/schema";

export type ChatLaunch = {
  id: string;
  prompt: string;
  mode: ConversationMode;
};

export function chatLaunchFromState(state: unknown): ChatLaunch | undefined {
  if (!state || typeof state !== "object" || !("chatLaunch" in state)) return;
  const launch = state.chatLaunch;
  if (
    launch &&
    typeof launch === "object" &&
    "id" in launch &&
    typeof launch.id === "string" &&
    "prompt" in launch &&
    typeof launch.prompt === "string" &&
    launch.prompt.length > 0 &&
    "mode" in launch &&
    launch.mode === "plan"
  ) {
    return { id: launch.id, prompt: launch.prompt, mode: launch.mode };
  }
}
