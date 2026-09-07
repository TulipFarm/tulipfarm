import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { validateSoulConfig } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import { mergeLlmConfigIntoSoulYaml, type SoulWriter } from "@tulipfarm/soul";
import { parse } from "yaml";
import { createUser, normalizeEmail, type UserRepo } from "../auth/users";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../runtime/soul-writer";
import type { SetupAdminCreator } from "./first-admin";
import { isProductionMode } from "./service";
import { mergeSoulConfig } from "./soul-config";

export interface BootstrapDeps {
  userRepo: UserRepo;
  setupAdminCreator?: SetupAdminCreator;
  secretsService: SecretsService;
  soulWriter: SoulWriter;
  log?: { info: (msg: string) => void; error: (msg: string) => void };
}

function llmProvider(): "anthropic" | "openai" {
  return process.env.LLM_PROVIDER === "openai" ? "openai" : "anthropic";
}

/** Matches the setup wizard's per-provider default, so both first-run paths seed the same model. */
const DEFAULT_MODEL: Record<"anthropic" | "openai", string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
};

function seedLlmConfig(content: string, provider: "anthropic" | "openai"): string {
  if (validateSoulConfig(parse(content)).llm !== undefined) return content;
  const entry = { provider, model: DEFAULT_MODEL[provider] };
  return mergeLlmConfigIntoSoulYaml(content, {
    tiers: {
      quick: { providers: [entry] },
      standard: { providers: [entry] },
      complex: { providers: [entry] },
    },
    presets: { default: "balanced" },
    mode: "basic",
  });
}

/**
 * Development-only escape hatch. Local `.env.local` ships a seeded dev admin so a reset never costs
 * a trip through the wizard, which would otherwise make the wizard itself untestable without
 * hand-editing the env file. Setting this restores the wizard for one run.
 */
function skipAdminBootstrap(): boolean {
  const raw = process.env.SKIP_ADMIN_BOOTSTRAP?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}

// Seeds the instance from env vars on first boot. Idempotent (no-op once users exist).
//
// Trigger conditions:
//   - ADMIN_EMAIL + ADMIN_PASSWORD + LLM_API_KEY all set → full headless seed (any env)
//   - ADMIN_EMAIL + ADMIN_PASSWORD set, LLM_API_KEY missing:
//       production → fail loud (refuse to boot)
//       non-production → seed admin only; developer configures LLM via Settings
//   - None of the above → no-op; wizard handles first-run via web UI
//
// After seeding, marks setupComplete=true in soul.yaml so the wizard never shows.
export async function bootstrapFromEnv(deps: BootstrapDeps): Promise<void> {
  if (skipAdminBootstrap()) {
    // Fail loud rather than silently downgrading a headless production deployment into one that
    // waits for a human at a browser wizard nobody is watching.
    if (isProductionMode()) {
      throw new Error(
        "SKIP_ADMIN_BOOTSTRAP is set, but it is a development-only escape hatch for exercising the " +
          "setup wizard. Unset it, or unset NODE_ENV=production."
      );
    }
    deps.log?.info("SKIP_ADMIN_BOOTSTRAP set — skipping headless seed; the setup wizard will run");
    return;
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPass = process.env.ADMIN_PASSWORD;
  const llmKey = process.env.LLM_API_KEY;

  if (!adminEmail || !adminPass) return;
  if ((await deps.userRepo.count()) > 0) return;

  // Partial headless: admin creds present but no LLM key → fail loud in production
  if (!llmKey && isProductionMode()) {
    throw new Error(
      "ADMIN_EMAIL + ADMIN_PASSWORD are set but LLM_API_KEY is missing. " +
        "Production headless deployments require all three. " +
        "Add LLM_API_KEY or remove ADMIN_EMAIL/ADMIN_PASSWORD to use the setup wizard."
    );
  }

  const base = await deps.soulWriter.readWithBase("Settings");
  let content = mergeSoulConfig(base.content, {
    setupComplete: true,
    ...(process.env.BUSINESS_NAME
      ? {
          businessName: process.env.BUSINESS_NAME,
          businessDescription: process.env.BUSINESS_DESCRIPTION ?? "",
        }
      : {}),
  });

  if (llmKey) {
    const provider = llmProvider();
    await deps.secretsService.set(`${provider}-api-key`, llmKey);
    deps.log?.info(`Seeded ${provider} LLM API key from env`);
    content = seedLlmConfig(content, provider);
  } else {
    deps.log?.info("LLM_API_KEY not set — configure models via Operate > Business > Models");
  }

  const result = await deps.soulWriter.apply({
    subject: "chore(soul): seed headless setup",
    source: "api",
    actor: SYSTEM_SOUL_COMMIT_ACTOR,
    businessId: DEPLOYMENT_BUSINESS_ID,
    expectedBaseCommit: base.baseCommit,
    changes: [{ op: "put", target: { kind: "Settings" }, content }],
  });
  if (!result.published) {
    throw new Error(`Headless setup could not publish: ${result.publicationError ?? "unknown"}`);
  }

  // A failed seed must remain retryable on the next boot, so create the first user last.
  const setupAdminCreator = deps.setupAdminCreator;
  const insert = setupAdminCreator
    ? (record: Parameters<SetupAdminCreator["create"]>[0]) => setupAdminCreator.create(record)
    : undefined;
  await createUser(deps.userRepo, adminEmail, adminPass, "admin", {
    setupBootstrap: true,
    ...(insert ? { insert } : {}),
  });
  deps.log?.info(`Bootstrapped admin user ${normalizeEmail(adminEmail)}`);
}
