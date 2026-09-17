import {
  ajv,
  PACK_READ_TOOL_DECLARATION,
  type PackReadInput,
  type PackSource,
  PackSourceSchema,
} from "@tulipfarm/schema";
import { defineApiTool, err, ok } from "@tulipfarm/tool-host";
import type { NetworkToolContext } from "../tools/network/tools";
import { PackReadError, PackService } from "./service";

const validate = ajv.compile<PackReadInput>(PACK_READ_TOOL_DECLARATION.inputSchema);
const validateSource = ajv.compile<PackSource>(PackSourceSchema);

export const packReadTool = defineApiTool<NetworkToolContext>({
  ...PACK_READ_TOOL_DECLARATION,
  tier: "platform",
  timeout: { wallClockMs: 20_000 },
  authorization: {
    action: "platform.plan.declare",
    resources: ["platform.plan"],
    dataClasses: ["operational"],
  },
  handler: async (args, context) => {
    if (!validate(args)) return err("validation_error", "Invalid Pack read arguments.");
    const source = {
      ...(args.url?.trim() ? { url: args.url } : {}),
      ...(args.yaml?.trim() ? { yaml: args.yaml } : {}),
    };
    if (!validateSource(source))
      return err("validation_error", "Provide exactly one of url or yaml.");
    if ("url" in source && context.spendBudget?.().allowed === false) {
      return err(
        "write_denied",
        "network_budget_exhausted: This Run has exhausted its network request budget."
      );
    }
    try {
      const result = await new PackService(context.http).preview(source, {
        ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
        assertDestination: context.assertSkillDestination,
        ...(args.expectedSha256 === undefined ? {} : { expectedSha256: args.expectedSha256 }),
      });
      return ok(result);
    } catch (error) {
      if (error instanceof PackReadError) {
        if (error.code === "pack_too_large") return err("oversize_value", error.message);
        return err(
          error.status === 400 ? "validation_error" : "unavailable",
          `${error.code}: ${error.message}`
        );
      }
      return err("unavailable", "Could not read the complete Pack source.");
    }
  },
});
