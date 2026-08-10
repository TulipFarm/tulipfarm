import type { SecretsService } from "@tulipfarm/secrets";
import { createUser, normalizeEmail, type UserRepo } from "../auth/users";
import { isProductionMode } from "./service";
import { patchSoulConfig } from "./soul-config";

export interface BootstrapDeps {
  userRepo: UserRepo;
  secretsService: SecretsService;
  soulPath: string;
  log?: { info: (msg: string) => void; error: (msg: string) => void };
}

function llmProvider(): "anthropic" | "openai" {
  return process.env.LLM_PROVIDER === "openai" ? "openai" : "anthropic";
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
    await createUser(deps.userRepo, adminEmail, adminPass, "admin");
    deps.log?.info(`Bootstrapped admin user ${normalizeEmail(adminEmail)}`);
  }

  if (process.env.BUSINESS_NAME) {
    await patchSoulConfig(deps.soulPath, {
      businessName: process.env.BUSINESS_NAME,
      businessDescription: process.env.BUSINESS_DESCRIPTION ?? "",
    });
  }

  if (llmKey) {
    await deps.secretsService.set(`${llmProvider()}-api-key`, llmKey);
    deps.log?.info(`Seeded ${llmProvider()} LLM API key from env`);
  } else {
    deps.log?.info("LLM_API_KEY not set — configure models via Operate > Business > Models");
  }

  // Mark setup complete so the web wizard never appears
  await patchSoulConfig(deps.soulPath, { setupComplete: true });
}
