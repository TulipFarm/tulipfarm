import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  ajv,
  GUARDRAIL_STAGE_BY_GUARD,
  type GuardrailStage,
  type GuardrailsConfig,
  guardrailStageFor,
  validateGuardrailsConfig,
} from "@tulipfarm/schema";
import { SoulWriteError } from "@tulipfarm/soul";
import { defineApiTool } from "@tulipfarm/tool-host";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../runtime/soul-writer";
import { mapSoulWriteError, soulCommitError } from "../tools/soul-faults";
import { firstError } from "./tool-args";
import { err, ok, type ToolCallResult } from "./tool-result";
import type { PlatformToolContext } from "./tools";

const SOUL_GUARDRAILS_TARGET = "soul.guardrails";
/** `guardrails.yaml` is a singleton, so a grant can only ever name the whole policy. */
const SOUL_GUARDRAILS_TARGET_ID = "policy";

const GUARDRAIL_FORGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["guard"],
  properties: {
    guard: {
      type: "object",
      required: ["guard"],
      properties: {
        guard: { type: "string", enum: Object.keys(GUARDRAIL_STAGE_BY_GUARD) },
      },
      description:
        "One guard object exactly as guardrails.yaml declares it. " +
        '`{"guard":"tool_blocklist","block":["record_delete","fs_*"]}` blocks Tool calls by name ' +
        "or glob and `category` blocks a whole Tool tier (system, platform, integration); " +
        '`{"guard":"content_filter","patterns":["credit_card","ssn","api_key","email"]}` filters ' +
        'the answer; `{"guard":"prompt_injection","sensitivity":"low|medium|high"}` screens the ' +
        "user's request.",
    },
  },
};
const validateGuardrailForge = ajv.compile(GUARDRAIL_FORGE_SCHEMA);

type GuardrailPolicyDocument = Record<string, unknown>;

/** Parse the authored `guardrails.yaml`; `null` means it is present but not a mapping. */
function readPolicy(content: string | null): GuardrailPolicyDocument | null {
  if (content === null || content.trim() === "") return {};
  const parsed: unknown = parseYaml(content);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as GuardrailPolicyDocument;
}

function stageGuards(policy: GuardrailPolicyDocument, stage: GuardrailStage): unknown[] {
  const existing = policy[stage];
  return Array.isArray(existing) ? [...existing] : [];
}

export const guardrailForgeTool = defineApiTool<PlatformToolContext>({
  name: "guardrail_forge",
  requiresAmbient: ["soul"],
  description:
    "Add a GUARDRAIL (a limit every agent is checked against) to the Soul's guardrails policy. " +
    "Use this whenever the user asks to 'block a tool', 'stop agents from doing X', 'add a " +
    "guardrail', or 'filter secrets out of replies'. Pass exactly one `guard` object; the stage " +
    "it runs in follows from its `guard` name, so never send a stage. The Tool merges it into the " +
    "existing policy, validates the whole result, commits guardrails.yaml to the Soul repo, and " +
    "reloads the live policy so the Guardrail is enforced on the next turn. It only adds: it " +
    "never removes or weakens a guard already configured.",
  mutating: true,
  tier: "platform",
  inputSchema: GUARDRAIL_FORGE_SCHEMA,
  authorization: {
    action: "platform.guardrail.forge",
    resources: [SOUL_GUARDRAILS_TARGET],
    targets: () => [{ type: SOUL_GUARDRAILS_TARGET, id: SOUL_GUARDRAILS_TARGET_ID }],
    dataClasses: ["soul_definition"],
  },
  handler: async (args, ctx): Promise<ToolCallResult> => {
    if (!validateGuardrailForge(args))
      return err("validation_error", firstError(validateGuardrailForge.errors));
    const { guard } = args as { guard: Record<string, unknown> };
    const name = guard.guard;
    if (typeof name !== "string") return err("validation_error", "guard.guard must be a string");
    const stage = guardrailStageFor(name);
    if (stage === undefined) return err("validation_error", `unknown guard "${name}"`);

    // A Turn enforces the in-process policy, so a deployment that cannot reload it would commit a
    // Guardrail that does not guard anything until the next restart. Refuse before writing.
    if (!ctx.onGuardrailsChanged)
      return err("internal_error", "Guardrail policy reload is not available in this deployment.");

    const current = await ctx.soulWriter.readWithBase("GuardrailsPolicy");
    const policy = readPolicy(current.content);
    if (policy === null)
      return err("validation_error", "guardrails.yaml is not a mapping and must be repaired first");

    const guards = stageGuards(policy, stage);
    if (guards.some((existing) => JSON.stringify(existing) === JSON.stringify(guard)))
      return err("validation_error", `an identical ${name} guard is already configured`);

    const next: GuardrailPolicyDocument = { ...policy, [stage]: [...guards, guard] };
    let validated: GuardrailsConfig;
    try {
      validated = validateGuardrailsConfig(next);
    } catch (error) {
      return err("validation_error", error instanceof Error ? error.message : String(error));
    }

    let write: Awaited<ReturnType<PlatformToolContext["soulWriter"]["apply"]>>;
    try {
      write = await ctx.soulWriter.apply({
        subject: `soul: add ${name} guardrail`,
        source: "agent",
        actor: ctx.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
        businessId: DEPLOYMENT_BUSINESS_ID,
        changes: [
          {
            op: "put",
            target: { kind: "GuardrailsPolicy" },
            content: stringifyYaml(validated),
          },
        ],
        expectedBaseCommit: current.baseCommit,
      });
    } catch (e) {
      if (e instanceof SoulWriteError) return mapSoulWriteError(e);
      return soulCommitError(e, e instanceof Error ? e.message : String(e));
    }

    try {
      await ctx.onGuardrailsChanged();
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }

    // Unlike a Routine, a Guardrail is enforced from the reloaded in-process policy rather than
    // from the published bundle, so a publication failure leaves it live. Reported, never fatal.
    return ok({
      guard: name,
      stage,
      enforced: true,
      published: write.published,
      ...(write.published ? {} : { publicationError: write.publicationError ?? null }),
    });
  },
});
