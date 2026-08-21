import {
  ajv,
  SKILL_MARKETPLACE_BROWSE_DESCRIPTION,
  SKILL_MARKETPLACE_BROWSE_SCHEMA,
  SKILL_SCANNED_AUDIT_DESCRIPTION,
  SKILL_SCANNED_AUDIT_SCHEMA,
  SKILL_SCANNED_INSTALL_DESCRIPTION,
  SKILL_SCANNED_INSTALL_SCHEMA,
  SKILL_SOURCE_SCAN_DESCRIPTION,
  SKILL_SOURCE_SCAN_SCHEMA,
} from "@tulipfarm/schema";
import {
  type CommitActor,
  SkillMarketplaceError,
  type SkillMarketplaceFlow,
} from "@tulipfarm/soul";
import { type ApiToolDefinition, defineApiTool } from "./define";
import { err, ok, type RequestContext, type ToolCallResult } from "./types";

export interface MarketplaceSkillToolContext {
  marketplace: SkillMarketplaceFlow;
  requestContext?: RequestContext;
}

const SYSTEM_MARKETPLACE_ACTOR: CommitActor = {
  principalId: "service:tulipfarm-system",
  name: "TulipFarm (system)",
  email: "",
};

function skillTargets(args: unknown) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  const name = (args as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? [{ type: "soul.skill", id: name }] : [];
}

function validationError(errors: ReturnType<typeof ajv.compile>["errors"]): ToolCallResult {
  const messages = (errors ?? []).map(
    (error) => `${error.instancePath || "(root)"} ${error.message}`
  );
  return err("validation_error", messages.length > 0 ? messages.join("; ") : "invalid arguments");
}

function marketplaceError(error: unknown): ToolCallResult {
  if (error instanceof SkillMarketplaceError) {
    const code =
      error.status === 409
        ? "audit_required"
        : error.status === 422
          ? "unavailable"
          : "validation_error";
    return err(code, error.message);
  }
  return err("unavailable", error instanceof Error ? error.message : String(error));
}

const validateBrowse = ajv.compile(SKILL_MARKETPLACE_BROWSE_SCHEMA);
const marketplaceBrowse = defineApiTool<MarketplaceSkillToolContext>({
  name: "skill_marketplace_browse",
  description: SKILL_MARKETPLACE_BROWSE_DESCRIPTION,
  tier: "system",
  mutating: false,
  inputSchema: SKILL_MARKETPLACE_BROWSE_SCHEMA,
  authorization: {
    action: "soul.skill.list",
    resources: ["soul.skill"],
    targets: () => [],
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateBrowse(args)) return validationError(validateBrowse.errors);
    try {
      return ok(await ctx.marketplace.browse());
    } catch (error) {
      return marketplaceError(error);
    }
  },
});

const validateScan = ajv.compile(SKILL_SOURCE_SCAN_SCHEMA);
const sourceScan = defineApiTool<MarketplaceSkillToolContext>({
  name: "skill_source_scan",
  description: SKILL_SOURCE_SCAN_DESCRIPTION,
  tier: "system",
  mutating: false,
  inputSchema: SKILL_SOURCE_SCAN_SCHEMA,
  authorization: {
    action: "soul.skill.list",
    resources: ["soul.skill"],
    targets: () => [],
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateScan(args)) return validationError(validateScan.errors);
    try {
      return ok(
        await ctx.marketplace.scan({
          source: (args as { source: string }).source,
          actorId: ctx.requestContext?.actor?.principalId ?? SYSTEM_MARKETPLACE_ACTOR.principalId,
        })
      );
    } catch (error) {
      return marketplaceError(error);
    }
  },
});

const validateAudit = ajv.compile(SKILL_SCANNED_AUDIT_SCHEMA);
const scannedAudit = defineApiTool<MarketplaceSkillToolContext>({
  name: "skill_scanned_audit",
  description: SKILL_SCANNED_AUDIT_DESCRIPTION,
  tier: "system",
  mutating: false,
  inputSchema: SKILL_SCANNED_AUDIT_SCHEMA,
  authorization: {
    action: "soul.skill.read",
    resources: ["soul.skill"],
    targets: skillTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateAudit(args)) return validationError(validateAudit.errors);
    try {
      return ok(
        await ctx.marketplace.audit(args as { scanId: string; name: string; skillPath: string })
      );
    } catch (error) {
      return marketplaceError(error);
    }
  },
});

const validateInstall = ajv.compile(SKILL_SCANNED_INSTALL_SCHEMA);
const scannedInstall = defineApiTool<MarketplaceSkillToolContext>({
  name: "skill_scanned_install",
  description: SKILL_SCANNED_INSTALL_DESCRIPTION,
  tier: "system",
  mutating: true,
  inputSchema: SKILL_SCANNED_INSTALL_SCHEMA,
  authorization: {
    action: "soul.skill.create",
    resources: ["soul.skill"],
    targets: skillTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateInstall(args)) return validationError(validateInstall.errors);
    const selection = args as { scanId: string; name: string; skillPath: string };
    try {
      return ok(
        await ctx.marketplace.install({
          scanId: selection.scanId,
          names: [selection.name],
          paths: [selection.skillPath],
          actor: ctx.requestContext?.actor ?? SYSTEM_MARKETPLACE_ACTOR,
        })
      );
    } catch (error) {
      return marketplaceError(error);
    }
  },
});

export const MARKETPLACE_SKILL_TOOLS: readonly ApiToolDefinition<MarketplaceSkillToolContext>[] = [
  marketplaceBrowse,
  sourceScan,
  scannedAudit,
  scannedInstall,
];
