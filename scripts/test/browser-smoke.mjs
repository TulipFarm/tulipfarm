#!/usr/bin/env node
/*
 * Headless-browser smoke test against a real installed instance.
 *
 * Exists because the jsdom suite structurally cannot catch a whole class of prod-only bugs:
 * jsdom is always a secure context and never enforces CSP, and `installer-smoke.sh` only ever
 * curled `/health` — so nothing in CI had executed a single line of the shipped JS bundle.
 * Two prod outages came from exactly that gap (secure-context-only `crypto.randomUUID`, and a
 * CSP `script-src` missing `unsafe-eval` that put the app in a reload loop).
 *
 * The origin matters more than anything else here: it must be the LAN-IP `PUBLIC_URL` the
 * installer generated, NOT localhost. localhost is a secure context by spec carve-out, which
 * would silently restore `crypto.randomUUID` and make this test vacuous. `--require-insecure`
 * turns that into a hard failure so CI can never quietly lose the coverage.
 *
 * Drives the real product surfaces (setup wizard → chat send), per AGENTS.md. It also ports the
 * access-control spine from scripts/test/browser/knowledge-denial.spec.ts: that Playwright suite
 * is local-only and never runs in CI, so this is the only place CI proves a restricted Page is
 * indistinguishable from one that does not exist, in a real browser, to a second real member.
 *
 * Usage: node scripts/test/browser-smoke.mjs <base-url> [--require-insecure]
 */

import { chromium } from "playwright";

const BASE_URL = process.argv[2];
const REQUIRE_INSECURE = process.argv.includes("--require-insecure");

if (!BASE_URL) {
  console.error("usage: browser-smoke.mjs <base-url> [--require-insecure]");
  process.exit(2);
}

const EMAIL = "smoke@tulipfarm.test";
const PASSWORD = "smoke-password-123";
const BUSINESS = "Smoke Test Co";
const MESSAGE = "browser smoke test message";

// The ACL denial spine (ported from scripts/test/browser/knowledge-denial.spec.ts) needs a second,
// ordinary member to be refused. MEMBER_A_LABEL is the admin's display name — the same one typed
// into the setup wizard below — because the reader directory labels a named user by name.
const COLLEAGUE_EMAIL = "colleague@tulipfarm.test";
const COLLEAGUE_PASSWORD = "colleague-password-123";
const MEMBER_A_LABEL = "Smoke Test";

const log = (msg) => console.log(`\x1b[0;36m[browser-smoke]\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[0;31m[browser-smoke] FAIL:\x1b[0m ${msg}`);
  process.exitCode = 1;
};

// Matches the Playwright suite's expect timeout so a slow-but-correct surface is not misread as a
// leak. These throw so a denial failure lands in the top-level catch, which screenshots.
const ASSERT_TIMEOUT = 30_000;

const seen = async (locator, what, state = "visible") => {
  try {
    await locator.waitFor({ state, timeout: ASSERT_TIMEOUT });
  } catch {
    throw new Error(`expected ${state}: ${what}`);
  }
};

const absent = async (locator, what) => {
  const count = await locator.count();
  if (count !== 0) throw new Error(`expected absent, found ${count}: ${what}`);
};

const counted = async (locator, expected, what) => {
  const got = await locator.count();
  if (got !== expected) throw new Error(`expected ${expected}, got ${got}: ${what}`);
};

const checkedOn = async (locator, what) => {
  if (!(await locator.isChecked())) throw new Error(`expected checked: ${what}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: BASE_URL });
const page = await context.newPage();

// Uncaught exceptions are the signal that matters: that is how both prod outages presented.
// Console noise (failed LLM fetches, 4xx logs) is deliberately NOT treated as failure — the
// LLM key is absent by design, so those are expected and would only make this flaky.
const pageErrors = [];
let loadCount = 0;

page.on("pageerror", (err) => pageErrors.push(err.message));
page.on("load", () => {
  loadCount += 1;
});

// CSP violations do not always surface as pageerror, so capture them at the source.
await context.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"}`);
  });
});

const cspViolations = async () => {
  try {
    return await page.evaluate(() => window.__cspViolations ?? []);
  } catch {
    return [];
  }
};

async function settle() {
  await page.waitForLoadState("networkidle").catch(() => {});
}

// Provision the Business's second, ordinary member through the real invite surfaces, mirroring
// scripts/test/browser/second-member.setup.ts. The denial claim is empty without a distinct
// identity to refuse, and per AGENTS.md that identity must be created through the product, never by
// seeding the database. Returns the colleague's session so each later step can open a fresh
// context — a cached document must never be what lets a refusal assertion pass.
async function provisionColleague() {
  await page.goto("/business/access");
  await seen(page.getByRole("heading", { name: "Who can do what" }), "business access page loaded");

  const alreadyMember = (await page.getByText(COLLEAGUE_EMAIL).count()) > 0;
  let inviteLink = null;
  if (!alreadyMember) {
    await page.getByRole("button", { name: "Invite someone" }).click();
    await page.getByLabel("Email").fill(COLLEAGUE_EMAIL);
    await page.getByRole("button", { name: "Create the invite link" }).click();
    const code = page.locator("code").filter({ hasText: "accept-invite" });
    await seen(code, "invite link issued");
    inviteLink = await code.textContent();
  }

  const colleagueContext = await browser.newContext({ baseURL: BASE_URL });
  const colleaguePage = await colleagueContext.newPage();
  try {
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
    await seen(colleaguePage.getByLabel("Message"), "colleague reached the app shell");
    return await colleagueContext.storageState();
  } finally {
    await colleagueContext.close();
  }
}

async function openColleague(state) {
  const context = await browser.newContext({ baseURL: BASE_URL, storageState: state });
  return { context, page: await context.newPage() };
}

// Ported from scripts/test/browser/knowledge-denial.spec.ts. The Playwright suite never runs in CI,
// so without this the access-control spine — a restricted Page being indistinguishable from one
// that does not exist, on every surface — would have no CI browser coverage at all. Every absence
// below is preceded by proving the surface actually answered for this session (the open Page),
// because a bare "not present" passes for free against a screen that rendered nothing.
async function runAclDenialSpine() {
  log("ACL denial spine: provisioning a second member and authoring two Pages");
  const colleagueState = await provisionColleague();

  // Unique per run so a re-run never collides with a Space a failed run left behind.
  const stamp = Date.now().toString(36);
  const spaceName = `Denial ${stamp}`;
  const tag = `denial${stamp}`;
  const openPath = "handbook";
  const openTitle = `open-handbook-${stamp}`;
  const restrictedPath = "quarterly";
  const secret = `severance-terms-${stamp}`;

  await page.goto("/knowledge/spaces/new");
  await page.locator("#name").fill(spaceName);
  await page.getByRole("button", { name: "Create" }).click();
  // A UUID, not `[^/]+`: the creation form itself lives at /spaces/new, so a loose pattern matches
  // before navigation and the rest of the journey would run against "new".
  await page.waitForURL(/\/knowledge\/spaces\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, {
    timeout: 60_000,
  });
  const spaceUrl = page.url();
  const spaceId = decodeURIComponent(spaceUrl.split("/spaces/")[1]);

  const authorPage = async (path, title, body) => {
    await page.goto(`${spaceUrl}/pages/new`);
    await page.locator("#path").fill(path);
    await page.getByRole("button", { name: "raw" }).click();
    await page
      .locator("#raw")
      .fill(`---\ntype: Note\ntitle: ${title}\ntags: [${tag}]\n---\n\n${body}\n`);
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForURL(/\/knowledge\/pages\/[^/]+/, { timeout: 60_000 });
    await seen(page.getByRole("heading", { name: title }), `admin authored ${title}`);
    return new URL(page.url()).pathname;
  };

  await authorPage(openPath, openTitle, `${openTitle} is readable by the whole business.`);
  const pageUrl = await authorPage(restrictedPath, secret, `${secret} details.`);

  // A newly created Space is personally owned. Share the Space with the colleague first so the
  // control read below proves the later Page-level restriction, not the Space ownership boundary.
  await page.goto(`/knowledge/spaces/${encodeURIComponent(spaceId)}/edit`);
  await page.getByRole("button", { name: "Choose who can read it" }).click();
  await seen(page.getByTestId("replace-note"), "space share dialog opened");
  await page.getByRole("checkbox", { name: COLLEAGUE_EMAIL, exact: true }).check();
  await page.getByRole("button", { name: /^Restrict/ }).click();
  await seen(page.getByTestId("replace-note"), "space share dialog closed", "hidden");

  let colleague = null;
  try {
    // Control: the colleague can read it before restriction, so every absence below is known to be
    // access control at work rather than a screen that merely rendered nothing.
    colleague = await openColleague(colleagueState);
    await colleague.page.goto(pageUrl);
    await seen(
      colleague.page.getByRole("heading", { name: secret }),
      "colleague reads the Page before restriction"
    );

    // Member A restricts the Page to themselves through the dialog.
    await page.goto(pageUrl);
    await page.getByRole("button", { name: "Who can read this" }).click();
    await seen(page.getByTestId("replace-note"), "restrict dialog opened");
    await page.getByRole("checkbox", { name: MEMBER_A_LABEL, exact: true }).check();
    await page.getByRole("button", { name: /^Restrict/ }).click();
    await seen(page.getByTestId("replace-note"), "restrict dialog closed", "hidden");

    // A fresh context, not a reload: a cached document would otherwise pass the refusal for free.
    await colleague.context.close();
    colleague = await openColleague(colleagueState);

    // Direct fetch: indistinguishable from a Page that was never written, and the title — usually
    // the whole secret — must not appear.
    await colleague.page.goto(pageUrl);
    await seen(
      colleague.page.getByText(/not found/i).first(),
      "restricted Page reads as not found"
    );
    await absent(colleague.page.getByText(secret), "secret absent on the direct Page");

    // Space tree: the open Page proves the tree was built for this session; only then is the
    // restricted Page's absence meaningful.
    await colleague.page.goto(`/knowledge/spaces/${encodeURIComponent(spaceId)}`);
    await seen(colleague.page.getByText(openPath).first(), "space tree rendered", "attached");
    await absent(colleague.page.getByText(secret), "secret absent in the space tree");
    await absent(colleague.page.getByText(restrictedPath), "restricted path absent in the tree");

    // Search palette: the open Page is found first, proving search answers for this session.
    await colleague.page.keyboard.press("Control+k");
    const palette = colleague.page.getByRole("dialog", { name: "Search knowledge" });
    const search = palette.getByPlaceholder("Search knowledge…");
    await seen(search, "search palette opened");
    await search.fill(openTitle);
    const openHit = palette.getByRole("option").filter({ hasText: openTitle });
    await seen(openHit, "search returns the open Page");
    await counted(openHit, 1, "search returns exactly the open Page");
    await search.fill(secret);
    await seen(palette.getByText("No pages found."), "search finds nothing for the secret");
    await absent(palette.getByText(secret), "secret absent in search");
    await colleague.page.keyboard.press("Escape");

    // Tag listing: both Pages carry the tag, so the listing is answering; only the open one shows.
    await colleague.page.goto(`/knowledge/tags/${encodeURIComponent(tag)}`);
    await seen(
      colleague.page.getByRole("main").getByText(openTitle).first(),
      "tag listing rendered"
    );
    await absent(colleague.page.getByText(secret), "secret absent in the tag listing");

    // Member A names the colleague; the same Page becomes readable to them.
    await page.goto(pageUrl);
    await page.getByRole("button", { name: "Who can read this" }).click();
    const colleagueBox = page.getByRole("checkbox", { name: COLLEAGUE_EMAIL, exact: true });
    await seen(colleagueBox, "grant dialog lists the colleague");
    await checkedOn(
      page.getByRole("checkbox", { name: MEMBER_A_LABEL, exact: true }),
      "admin remains a reader"
    );
    await colleagueBox.check();
    await page.getByRole("button", { name: /^Restrict/ }).click();
    await seen(page.getByTestId("replace-note"), "grant dialog closed", "hidden");

    await colleague.context.close();
    colleague = await openColleague(colleagueState);
    await colleague.page.goto(pageUrl);
    await seen(
      colleague.page.getByRole("heading", { name: secret }),
      "colleague reads the Page once named"
    );

    log("ACL denial spine: PASS — restricted Page was invisible until the colleague was named");
  } finally {
    await colleague?.context.close().catch(() => {});
    // Idempotent re-runs: remove the Space and everything under it, whatever happened above.
    await page.goto(`/knowledge/spaces/${encodeURIComponent(spaceId)}/edit`).catch(() => {});
    const del = page.getByRole("button", { name: "Delete", exact: true });
    if (await del.count().catch(() => 0)) {
      await del.click().catch(() => {});
      await page
        .getByRole("button", { name: "Confirm delete" })
        .click()
        .catch(() => {});
    }
    await page.goto("/").catch(() => {});
  }
}

try {
  log(`opening ${BASE_URL}`);
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settle();

  // The whole point of this test. Assert before anything else so a misconfigured origin fails
  // loudly rather than passing a weaker test than advertised.
  const isSecure = await page.evaluate(() => window.isSecureContext);
  if (isSecure) {
    const msg =
      `${BASE_URL} is a SECURE context — secure-context-only APIs are available, so this run ` +
      "does NOT cover the non-secure-context bug class. Point this at the installer's LAN-IP " +
      "PUBLIC_URL, not localhost.";
    if (REQUIRE_INSECURE) throw new Error(msg);
    console.warn(`\x1b[0;33m[browser-smoke] WARNING:\x1b[0m ${msg}`);
  } else {
    log("confirmed non-secure context — secure-context-only APIs are unavailable");
  }

  // First run lands on the setup wizard; a re-run against an already-configured instance lands
  // on the sign-in page. Both are client-side redirects, so the URL must be awaited explicitly —
  // an optional-group pattern would match the pre-redirect "/" and branch on stale state.
  await page.waitForURL(/\/(setup|login)\b/, { timeout: 60_000 });
  const onSetup = page.url().includes("/setup");

  if (onSetup) {
    log("running the setup wizard");

    // One question per screen: name, email, password, business name. Only the last screen
    // renders "Finish", so every earlier answer has to be submitted with "Continue".
    await page.locator('input[type="text"]').fill("Smoke Test");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator('input[type="email"]').fill(EMAIL);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator('input[type="text"]').fill(BUSINESS);
    await page.getByRole("button", { name: "Finish" }).click();
  } else {
    log("instance already configured — signing in");
    await page.getByLabel("email").fill(EMAIL);
    await page.getByLabel("password").fill(PASSWORD);
    await page.getByRole("button", { name: /Sign in/i }).click();
  }

  await page.waitForURL(`${BASE_URL}/`, { timeout: 60_000 });
  await settle();
  log("reached the app shell");

  // The reported crash fired inside the chat reducer on send, before any network call, so the
  // send has to actually happen — loading the page alone would not have caught it.
  const composer = page.getByLabel("Message");
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.click();
  await page.keyboard.type(MESSAGE);
  await page.getByRole("button", { name: /send/i }).click();

  // The user message only renders if `appendUserMessage` → `newId()` → randomUUID() survived.
  // This is the assertion that makes the test non-vacuous.
  await page.getByText(MESSAGE).first().waitFor({ state: "visible", timeout: 30_000 });
  log("chat send rendered the user message — reducer ran clean");

  // The reload-loop bug is a boot-phase failure — a CSP/module error driving the reload-on-failure
  // handler — so assert it here, before the ACL journey below navigates the admin page many times
  // and would inflate a naive load counter.
  if (loadCount > 5) fail(`page loaded ${loadCount} times — looks like a reload loop`);

  await runAclDenialSpine();

  // Remix's root boundary renders this when a route throws.
  if (await page.getByText("Application Error").count()) {
    fail("the app rendered Remix's 'Application Error' boundary");
  }

  const violations = await cspViolations();
  if (violations.length) fail(`CSP violations: ${[...new Set(violations)].join("; ")}`);

  if (pageErrors.length) {
    fail(`uncaught page errors:\n    ${[...new Set(pageErrors)].join("\n    ")}`);
  }

  if (!process.exitCode) {
    log("PASS — wizard completed, chat send clean, ACL denial holds, no CSP violations");
  }
} catch (err) {
  fail(err.message);
  await page.screenshot({ path: "browser-smoke-failure.png", fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}
