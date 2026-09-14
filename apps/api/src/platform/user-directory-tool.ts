import { ajv } from "@tulipfarm/schema";
import { type ApiToolDefinition, defineApiTool } from "@tulipfarm/tool-host";
import { firstError } from "./tool-args";
import { err, ok } from "./tool-result";
import type { PlatformToolContext } from "./tools";

const USER_DIRECTORY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description: "Optional search query to filter users by display name, email, or handle.",
    },
  },
};
const validateUserDirectory = ajv.compile(USER_DIRECTORY_SCHEMA);

export const userDirectoryTool = defineApiTool<PlatformToolContext>({
  name: "user_resolve",
  description:
    "Search and resolve TulipFarm instance users by display name, email, or handle. " +
    "Use this when you need to assign a task or create a record for a specific team member and " +
    "custom employee/contact records do not exist or do not match.",
  mutating: false,
  tier: "platform",
  requiresApproval: false,
  inputSchema: USER_DIRECTORY_SCHEMA,
  authorization: {
    action: "user.directory.read",
    resources: ["user"],
    dataClasses: ["operational"],
  },
  handler: async (args, ctx) => {
    if (!validateUserDirectory(args)) {
      return err("validation_error", firstError(validateUserDirectory.errors));
    }
    const { query } = args as { query?: string };

    if (!ctx.users) {
      return err("internal_error", "User directory is unavailable");
    }

    try {
      const allUsers = await ctx.users.listAll();

      let filtered = allUsers;
      if (query && query.trim() !== "") {
        const lowerQuery = query.toLowerCase().trim();
        filtered = allUsers.filter((user) => {
          const nameMatch = user.name?.toLowerCase().includes(lowerQuery);
          const emailMatch = user.email.toLowerCase().includes(lowerQuery);
          return nameMatch || emailMatch;
        });
      }

      const results = filtered.map((user) => ({
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
      }));

      return ok({ users: results });
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }
  },
});
