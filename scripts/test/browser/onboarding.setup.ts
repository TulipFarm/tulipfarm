import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { completeOrSignIn, expect, openProductionRoot, test } from "./fixtures";

test("complete Onboarding and save browser state", async ({ page }) => {
  await openProductionRoot(page);
  await page.waitForURL(/\/(setup|login)\b/, { timeout: 60_000 });
  const wasSetup = page.url().includes("/setup");
  if (process.env.CI && !wasSetup) {
    throw new Error("CI browser bootstrap expected a fresh Onboarding wizard");
  }

  await completeOrSignIn(page);
  await expect(page.getByLabel("Message")).toBeVisible();
  mkdirSync(resolve("scripts/test/.auth"), { recursive: true });
  await page.context().storageState({ path: resolve("scripts/test/.auth/user.json") });
});
