import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  COLLEAGUE_EMAIL,
  COLLEAGUE_PASSWORD,
  completeOrSignIn,
  expect,
  openProductionRoot,
  test,
} from "./fixtures";

/**
 * Seeds a second, ordinary member of the same Business — a "colleague" distinct from the admin
 * `onboarding.setup.ts` creates — and stores its session at scripts/test/.auth/colleague.json.
 * The "colleague" Playwright project (see playwright.config.ts) loads that file as its
 * storageState, so any `*.colleague.spec.ts` runs already signed in as this second person.
 *
 * Idempotent like onboarding.setup.ts: a re-run finds the colleague already invited and signs in
 * with the fixed password instead of inviting again.
 */
test("provision a second Business member and save its browser state", async ({ page, browser }) => {
  await openProductionRoot(page);
  await page.waitForURL(/\/(setup|login)\b/, { timeout: 60_000 });
  await completeOrSignIn(page); // first (admin) member — Business owner who does the inviting

  await page.goto("/business/access");
  await expect(page.getByRole("heading", { name: "Who can do what" })).toBeVisible();

  const alreadyMember = (await page.getByText(COLLEAGUE_EMAIL).count()) > 0;

  let inviteLink: string | null = null;
  if (!alreadyMember) {
    await page.getByRole("button", { name: "Invite someone" }).click();
    await page.getByLabel("Email").fill(COLLEAGUE_EMAIL);
    await page.getByRole("button", { name: "Create the invite link" }).click();
    const code = page.locator("code").filter({ hasText: "accept-invite" });
    await expect(code).toBeVisible();
    inviteLink = await code.textContent();
  }

  // A fresh context/page keeps the colleague's session separate from the admin's above — the
  // admin's page is never reused to sign anyone else in.
  const colleagueContext = await browser.newContext();
  const colleaguePage = await colleagueContext.newPage();

  if (inviteLink) {
    await colleaguePage.goto(inviteLink);
    await colleaguePage.getByLabel("password", { exact: true }).fill(COLLEAGUE_PASSWORD);
    await colleaguePage.getByLabel("confirm password").fill(COLLEAGUE_PASSWORD);
    await colleaguePage.getByRole("button", { name: "Set password and sign in" }).click();
  } else {
    await colleaguePage.goto("/");
    await colleaguePage.waitForURL(/\/login\b/, { timeout: 60_000 });
    await colleaguePage.getByLabel("email").fill(COLLEAGUE_EMAIL);
    await colleaguePage.getByLabel("password").fill(COLLEAGUE_PASSWORD);
    await colleaguePage.getByRole("button", { name: /Sign in/i }).click();
  }

  await colleaguePage.waitForURL(/\/$/, { timeout: 60_000 });
  await expect(colleaguePage.getByLabel("Message")).toBeVisible();

  // Prove the session is live before it is ever persisted: Knowledge sits behind the same auth
  // gate as everything else, so loading it here is a real authenticated request, not a fixture.
  // knowledge-as-colleague.colleague.spec.ts repeats this check from the saved file, in a fresh
  // process, which is what proves the persisted session — not just this in-memory one — works.
  await colleaguePage.goto("/knowledge");
  // Scoped to the content region: the sidebar carries an icon shortcut with the same accessible
  // name, and the claim here is that the *page* rendered for this session.
  await expect(
    colleaguePage.getByRole("main").getByRole("link", { name: "New space" })
  ).toBeVisible();

  mkdirSync(resolve("scripts/test/.auth"), { recursive: true });
  await colleagueContext.storageState({ path: resolve("scripts/test/.auth/colleague.json") });
  await colleagueContext.close();
});
