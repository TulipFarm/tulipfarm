import { COLLEAGUE_EMAIL, expect, openProductionRoot, test } from "./fixtures";

/**
 * The whole claim, in one journey, through a real browser.
 *
 * The rule-by-rule matrix lives at the API seam, where it is fast enough to be exhaustive. This
 * spec exists for the class of failure that seam structurally cannot see: a rule enforced correctly
 * in the domain but bypassed by a screen that fetches with the wrong identity, caches across
 * sessions, or renders from a store populated before the check ran. Every assertion below is made
 * against rendered HTML in a second, independently authenticated browser context.
 *
 * Runs as the first member (the default storageState). The colleague is a separate context loaded
 * from scripts/test/.auth/colleague.json, so the two identities never share a cookie jar, a service
 * worker, or a client-side cache.
 */

import { resolve } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";

/** Unique per run so a re-run never collides with a Space this spec failed to clean up. */
const STAMP = Date.now().toString(36);
const SPACE = `Denial ${STAMP}`;
const PAGE_PATH = "quarterly";
/** The string that must not reach the colleague on any surface. */
const SECRET = `severance-terms-${STAMP}`;
/**
 * A second Page in the same Space, sharing the same tag, that is never restricted. It is the
 * control for every absence below: an assertion that a secret is missing proves nothing on a screen
 * that rendered nothing, so each surface is first shown to be answering for this session by
 * producing this Page, and only then asked for the restricted one.
 */
const OPEN_PATH = "handbook";
const OPEN_TITLE = `open-handbook-${STAMP}`;
const TAG = `denial${STAMP}`;

const colleagueStorage = resolve("scripts/test/.auth/colleague.json");

/** The admin created by onboarding.setup.ts — the subject directory labels a user by name. */
const MEMBER_A_LABEL = "Smoke Test";

async function openAsColleague(browser: {
  newContext: (o: { storageState: string }) => Promise<BrowserContext>;
}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: colleagueStorage });
  return { context, page: await context.newPage() };
}

test("a restricted Page is invisible to a colleague on every surface until they are named", async ({
  page,
  browser,
}) => {
  await openProductionRoot(page);
  // Firefox aborts a goto that races the SPA's own first client-side navigation
  // (NS_BINDING_ABORTED), so wait for the app shell to settle before driving it.
  await expect(page.getByLabel("Message")).toBeVisible();

  // ---- Member A: create a Space and a Page, through the interface ------------------------------
  await page.goto("/knowledge/spaces/new");
  await page.locator("#name").fill(SPACE);
  await page.getByRole("button", { name: "Create" }).click();
  // A UUID, not `[^/]+` — the creation form itself lives at /knowledge/spaces/new, so a loose
  // pattern matches before the navigation happens and the rest of the journey runs against "new".
  await page.waitForURL(/\/knowledge\/spaces\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, {
    timeout: 60_000,
  });
  const spaceUrl = page.url();
  const spaceId = decodeURIComponent(spaceUrl.split("/spaces/")[1]);

  const authorPage = async (path: string, title: string, body: string): Promise<string> => {
    await page.goto(`${spaceUrl}/pages/new`);
    await page.locator("#path").fill(path);
    await page.getByRole("button", { name: "raw" }).click();
    await page
      .locator("#raw")
      .fill(`---\ntype: Note\ntitle: ${title}\ntags: [${TAG}]\n---\n\n${body}\n`);
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForURL(/\/knowledge\/pages\/[^/]+/, { timeout: 60_000 });
    // The heading, not any text: the same title also renders in the navigation tree, which is
    // off-canvas on a phone viewport and would make this assertion viewport-dependent.
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    return new URL(page.url()).pathname;
  };

  await authorPage(OPEN_PATH, OPEN_TITLE, `${OPEN_TITLE} is readable by the whole business.`);
  const pageUrl = await authorPage(PAGE_PATH, SECRET, `${SECRET} details.`);

  let colleague: { context: BrowserContext; page: Page } | null = null;
  try {
    // Before restricting, the colleague can read it — otherwise every assertion below could pass
    // for reasons that have nothing to do with access control.
    colleague = await openAsColleague(browser);
    await colleague.page.goto(pageUrl);
    await expect(colleague.page.getByRole("heading", { name: SECRET })).toBeVisible();

    // ---- Member A restricts the Page to themselves, through the dialog -------------------------
    await page.goto(pageUrl);
    await page.getByRole("button", { name: "Who can read this" }).click();
    await expect(page.getByTestId("replace-note")).toBeVisible();
    await page.getByRole("checkbox", { name: MEMBER_A_LABEL, exact: true }).check();
    await page.getByRole("button", { name: /^Restrict/ }).click();
    await expect(page.getByTestId("replace-note")).toBeHidden();

    // ---- Member B is refused, and the refusal says nothing ------------------------------------
    // A fresh context, not a reload: a cached document would otherwise pass this for free.
    await colleague.context.close();
    colleague = await openAsColleague(browser);

    // Every absence below is preceded by an assertion that the surface actually rendered. A bare
    // `toHaveCount(0)` passes on the first poll against a blank page, so on its own it proves the
    // screen was slow, not that the Page was withheld.
    await colleague.page.goto(pageUrl);
    // Indistinguishable from a Page that was never written — the title is usually the whole secret.
    await expect(colleague.page.getByText(/not found/i).first()).toBeVisible();
    await expect(colleague.page.getByText(SECRET)).toHaveCount(0);

    await colleague.page.goto(`/knowledge/spaces/${encodeURIComponent(spaceId)}`);
    // Attached, not visible: the tree is off-canvas on a phone viewport, and the claim here is
    // about what the tree was built from, not about what fits on screen. The open Page proves it
    // was built for this session, which is what makes the restricted Page's absence meaningful.
    await expect(colleague.page.getByText(OPEN_PATH).first()).toBeAttached();
    await expect(colleague.page.getByText(SECRET)).toHaveCount(0);
    await expect(colleague.page.getByText(PAGE_PATH)).toHaveCount(0);

    await colleague.page.keyboard.press("Control+k");
    const palette = colleague.page.getByRole("dialog", { name: "Search knowledge" });
    const search = palette.getByPlaceholder("Search knowledge…");
    await expect(search).toBeVisible();
    // Scoped to the palette: the sidebar tree renders Space and Page names too, so an unscoped
    // match would report the page behind the dialog as a search result.
    await search.fill(OPEN_TITLE);
    await expect(palette.getByRole("option").filter({ hasText: OPEN_TITLE })).toHaveCount(1);
    await search.fill(SECRET);
    await expect(palette.getByText("No pages found.")).toBeVisible();
    await expect(palette.getByText(SECRET)).toHaveCount(0);
    await colleague.page.keyboard.press("Escape");

    await colleague.page.goto(`/knowledge/tags/${encodeURIComponent(TAG)}`);
    // Both Pages carry this tag, so the listing is answering; only one of them may appear.
    await expect(colleague.page.getByRole("main").getByText(OPEN_TITLE).first()).toBeVisible();
    await expect(colleague.page.getByText(SECRET)).toHaveCount(0);

    // ---- Member A names the colleague; member B reads it ---------------------------------------
    await page.goto(pageUrl);
    await page.getByRole("button", { name: "Who can read this" }).click();
    const colleagueBox = page.getByRole("checkbox", { name: COLLEAGUE_EMAIL, exact: true });
    await expect(colleagueBox).toBeVisible();
    // Member A stays checked — the dialog seeds itself from the current list, and unchecking them
    // here would prove nothing about *adding* a reader.
    await expect(page.getByRole("checkbox", { name: MEMBER_A_LABEL, exact: true })).toBeChecked();
    await colleagueBox.check();
    await page.getByRole("button", { name: /^Restrict/ }).click();
    await expect(page.getByTestId("replace-note")).toBeHidden();

    await colleague.context.close();
    colleague = await openAsColleague(browser);
    await colleague.page.goto(pageUrl);
    await expect(colleague.page.getByRole("heading", { name: SECRET })).toBeVisible();
  } finally {
    await colleague?.context.close();
    // Idempotent re-runs: the Space and everything under it go, whatever happened above.
    await page.goto(`/knowledge/spaces/${encodeURIComponent(spaceId)}/edit`).catch(() => {});
    const del = page.getByRole("button", { name: "Delete", exact: true });
    if (await del.count()) {
      await del.click();
      await page
        .getByRole("button", { name: "Confirm delete" })
        .click()
        .catch(() => {});
    }
  }
});
