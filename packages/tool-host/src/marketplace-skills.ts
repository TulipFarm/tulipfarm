import {
  ajv,
  SKILL_INSTALL_DESCRIPTION,
  SKILL_INSTALL_SCHEMA,
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

/**
 * Wall clocks for the Tools that reach a remote, because the host's 30s default is narrower than
 * the budgets they wait on and so fired first every time: a clone may take 60s
 * (`DEFAULT_GIT_CLONE_LIMITS.timeoutMs`) and SkillAudit 45s (`SKILL_AUDIT.timeoutMs`). An install
 * from a URL does both in one call, which no 30s deadline can ever contain — `skill_install`
 * failed at 32s against a real catalogue URL without once reaching the audit it exists to run.
 *
 * The headroom matches `skill_create`'s and covers the Soul commit and reload that follow.
 * `apps/api/src/tools/marketplace-timeouts.test.ts` pins these against the real inner budgets,
 * which live in packages this one does not depend on, so raising one of those fails there rather
 * than silently restoring a deadline that cannot be met.
 */
const CLONE_BUDGET_MS = 60_000;
const AUDIT_BUDGET_MS = 45_000;
const TIMEOUT_HEADROOM_MS = 15_000;

/** Clones a remote. */
const SKILL_CLONE_TOOL_TIMEOUT_MS = CLONE_BUDGET_MS + TIMEOUT_HEADROOM_MS;
/** Audits an already-cloned package, so it waits on the model but not the network. */
const SKILL_AUDIT_TOOL_TIMEOUT_MS = AUDIT_BUDGET_MS + TIMEOUT_HEADROOM_MS;
/** Clones *and* audits in one call. */
const SKILL_INSTALL_TOOL_TIMEOUT_MS = CLONE_BUDGET_MS + AUDIT_BUDGET_MS + TIMEOUT_HEADROOM_MS;

export const MARKETPLACE_SKILL_TOOL_TIMEOUTS_MS = {
  skill_marketplace_browse: SKILL_CLONE_TOOL_TIMEOUT_MS,
  skill_source_scan: SKILL_CLONE_TOOL_TIMEOUT_MS,
  skill_scanned_audit: SKILL_AUDIT_TOOL_TIMEOUT_MS,
  skill_install: SKILL_INSTALL_TOOL_TIMEOUT_MS,
} as const;

/** The confirm token, read defensively because `classify` is typed against unvalidated arguments. */
function confirmTokenOf(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const confirm = (args as Record<string, unknown>).confirm;
  return typeof confirm === "string" && confirm.length > 0 ? confirm : undefined;
}

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
  timeout: { wallClockMs: SKILL_CLONE_TOOL_TIMEOUT_MS },
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
  timeout: { wallClockMs: SKILL_CLONE_TOOL_TIMEOUT_MS },
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
  timeout: { wallClockMs: SKILL_AUDIT_TOOL_TIMEOUT_MS },
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
  // Every path that writes a Skill asks a human first, or `skill_install`'s confirmation is just a
  // door with a second door beside it standing open.
  requiresApproval: true,
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

const validateSkillInstall = ajv.compile(SKILL_INSTALL_SCHEMA);
const skillInstall = defineApiTool<MarketplaceSkillToolContext>({
  name: "skill_install",
  description: SKILL_INSTALL_DESCRIPTION,
  tier: "system",
  mutating: true,
  timeout: { wallClockMs: SKILL_INSTALL_TOOL_TIMEOUT_MS },
  inputSchema: SKILL_INSTALL_SCHEMA,
  authorization: {
    action: "soul.skill.create",
    resources: ["soul.skill"],
    targets: skillTargets,
    dataClasses: ["soul_definition"],
  },
  // The audit only informs a decision if it is delivered before the write, and an agent that can
  // both read the report and act on it is deciding for the operator. So the first call is a pure
  // audit needing no approval, and the second - the one that writes - always needs a human.
  classify: (args) => {
    const confirmed = confirmTokenOf(args) !== undefined;
    return { mutating: confirmed, requiresApproval: confirmed };
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateSkillInstall(args)) return validationError(validateSkillInstall.errors);
    const { source, name, confirm } = args as { source: string; name?: string; confirm?: string };
    const actorId = ctx.requestContext?.actor?.principalId ?? SYSTEM_MARKETPLACE_ACTOR.principalId;
    try {
      if (confirm === undefined) {
        const prepared = await ctx.marketplace.prepareFromSource({ source, name, actorId });
        return ok({
          status: "needs_confirmation",
          instruction:
            "Nothing has been installed. Show the user the risk rating and every warning, then call skill_install again with `confirm` only if they say to go ahead.",
          source: prepared.source,
          name: prepared.name,
          skillPath: prepared.skillPath,
          warnings: prepared.warnings,
          report: prepared.report,
          confirm: prepared.scanId,
        });
      }
      const installed = await ctx.marketplace.installPrepared({
        scanId: confirm,
        source,
        name,
        actor: ctx.requestContext?.actor ?? SYSTEM_MARKETPLACE_ACTOR,
      });
      return ok({ status: "installed", ...installed });
    } catch (error) {
      return marketplaceError(error);
    }
  },
});

export const MARKETPLACE_SKILL_TOOLS: readonly ApiToolDefinition<MarketplaceSkillToolContext>[] = [
  skillInstall,
  marketplaceBrowse,
  sourceScan,
  scannedAudit,
  scannedInstall,
];
