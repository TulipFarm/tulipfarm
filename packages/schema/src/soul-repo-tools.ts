import { Type } from "@sinclair/typebox";

export const SOUL_REPO_PUSH_TOOL_DECLARATION = {
  name: "soul_repo_push",
  description:
    "Push committed soul changes to the configured git remote. Returns { pushed: false } when no remote is configured (local-only mode).",
  mutating: true,
  inputSchema: Type.Object({}, { additionalProperties: false }),
  authorization: {
    action: "platform.soul_repo.push",
    resources: ["soul.repo"],
    dataClasses: ["soul_definition"],
  },
} as const;
