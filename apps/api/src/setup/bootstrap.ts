import { mkdir } from "node:fs/promises";
import type { SecretsService } from "@tulipfarm/secrets";
import { createUser, normalizeEmail, type UserRepo } from "../auth/users";
import { writeLlmConfigToSoulYaml } from "../soul/llm-config/soul-yaml-io";
import type { SetupAdminCreator } from "./first-admin";
import { isProductionMode } from "./service";
import { patchSoulConfig, readSoulConfig } from "./soul-config";

export interface BootstrapDeps {
  userRepo: UserRepo;
  setupAdminCreator?: SetupAdminCreator;
  secretsService: SecretsService;
  soulPath: string;
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

/** Headless bootstrap seeds an LLM chain only when `llm:` is absent, preserving operator edits. */
async function seedLlmConfig(deps: BootstrapDeps, provider: "anthropic" | "openai"): Promise<void> {
  const existing = (await readSoulConfig(deps.soulPath)) as { llm?: unknown };
  if (existing.llm !== undefined) return;

  // `writeLlmConfigToSoulYaml` assumes the soul directory exists. Nothing guarantees that here:
  // the only earlier writer is the BUSINESS_NAME patch, which is optional.
  await mkdir(deps.soulPath, { recursive: true });
  const entry = { provider, model: DEFAULT_MODEL[provider] };
  await writeLlmConfigToSoulYaml(deps.soulPath, {
    tiers: {
      quick: { providers: [entry] },
      standard: { providers: [entry] },
      complex: { providers: [entry] },
    },
    presets: { default: "balanced" },
  });
  deps.log?.info(`Seeded LLM config: ${provider}/${entry.model} on all tiers`);
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
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPass = process.env.ADMIN_PASSWORD;
  const llmKey = process.env.LLM_API_KEY;

  if (!adminEmail || !adminPass) return;

  // Partial headless: admin creds present but no LLM key → fail loud in production
  if (!llmKey && isProductionMode()) {
    throw new Error(
      "ADMIN_EMAIL + ADMIN_PASSWORD are set but LLM_API_KEY is missing. " +
        "Production headless deployments require all three. " +
        "Add LLM_API_KEY or remove ADMIN_EMAIL/ADMIN_PASSWORD to use the setup wizard."
    );
  }

  if ((await deps.userRepo.count()) === 0) {
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

  if (process.env.BUSINESS_NAME) {
    await patchSoulConfig(deps.soulPath, {
      businessName: process.env.BUSINESS_NAME,
      businessDescription: process.env.BUSINESS_DESCRIPTION ?? "",
    });
  }

  if (llmKey) {
    const provider = llmProvider();
    await deps.secretsService.set(`${provider}-api-key`, llmKey);
    deps.log?.info(`Seeded ${provider} LLM API key from env`);
    await seedLlmConfig(deps, provider);
  } else {
    deps.log?.info("LLM_API_KEY not set — configure models via Operate > Business > Models");
  }

  // Mark setup complete so the web wizard never appears
  await patchSoulConfig(deps.soulPath, { setupComplete: true });
}
