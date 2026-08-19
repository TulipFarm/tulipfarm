import { expect, openProductionRoot, test } from "./fixtures";

/**
 * Runs under the "colleague" Playwright project (playwright.config.ts), whose storageState is
 * scripts/test/.auth/colleague.json — the file second-member.setup.ts persisted. Loading an
 * authenticated page here, from a session written to disk by a separate test, is the proof that
 * the stored session is real rather than merely a file that happens to exist.
 */
test("second member signs in from stored session and loads Knowledge", async ({ page }) => {
  await openProductionRoot(page);
  await expect(page.getByLabel("Message")).toBeVisible();
  await page.goto("/knowledge");
  await expect(page.getByRole("main").getByRole("link", { name: "New space" })).toBeVisible();
});
