import type { SecretsService } from "@tulipfarm/secrets";
import { type UserRepo, createUser, normalizeEmail } from "../auth/users";
import { isManagedMode } from "./service";
import { patchSoulConfig } from "./soul-config";

export interface BootstrapDeps {
  userRepo: UserRepo;
  secretsService: SecretsService;
  soulPath: string;
  log?: { info: (msg: string) => void };
}

// Env required to seed a managed deployment (no wizard to collect them).
const REQUIRED_MANAGED = ["ADMIN_EMAIL", "ADMIN_PASSWORD", "LLM_API_KEY"];

function llmProvider(): "anthropic" | "openai" {
  return process.env.LLM_PROVIDER === "openai" ? "openai" : "anthropic";
}

// Seeds the instance from env (INST-003b): generalizes bootstrapAdmin to also seed
// business config + the LLM secret. Idempotent. Managed mode fails loud on missing
// required env (INST-010); wizard mode treats every step as optional.
export async function bootstrapFromEnv(deps: BootstrapDeps): Promise<void> {
  if (isManagedMode()) {
    const missing = REQUIRED_MANAGED.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`SETUP_MODE=managed requires env vars: ${missing.join(", ")}`);
    }
  }

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (email && password && (await deps.userRepo.count()) === 0) {
    // Mirror the wizard's min-8 policy on the env path: fail loud in managed mode,
    // warn + skip in wizard mode (the operator can still finish via the UI).
    if (password.length < 8) {
      if (isManagedMode()) {
        throw new Error("ADMIN_PASSWORD must be at least 8 characters");
      }
      deps.log?.info("Skipping admin bootstrap: ADMIN_PASSWORD is shorter than 8 characters");
    } else {
      await createUser(deps.userRepo, email, password, "admin");
      deps.log?.info(`Bootstrapped admin user ${normalizeEmail(email)}`);
    }
  }

  if (process.env.BUSINESS_NAME) {
    await patchSoulConfig(deps.soulPath, {
      businessName: process.env.BUSINESS_NAME,
      businessDescription: process.env.BUSINESS_DESCRIPTION ?? "",
    });
  }

  if (process.env.LLM_API_KEY) {
    await deps.secretsService.set(`${llmProvider()}-api-key`, process.env.LLM_API_KEY);
  }
}
