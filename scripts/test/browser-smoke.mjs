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
 * Drives the real product surfaces (setup wizard → chat send), per AGENTS.md.
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
const MESSAGE = "browser smoke test message";

const log = (msg) => console.log(`\x1b[0;36m[browser-smoke]\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[0;31m[browser-smoke] FAIL:\x1b[0m ${msg}`);
  process.exitCode = 1;
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

    // Step 1 — admin account (email, password, confirm).
    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').nth(0).fill(PASSWORD);
    await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 2 — business profile. The description is optional; the name is not.
    await page.getByPlaceholder("Acme Corp").fill("Smoke Test Co");
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 3 — LLM config. Skipped: no API key in CI, and the chat crash we are hunting
    // happens client-side before any model call.
    await page.getByRole("button", { name: /Skip for now/i }).click();

    // Step 4 — soul git backup, optional.
    await page.getByRole("button", { name: "Skip", exact: true }).click();
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
  await page.getByRole("button", { name: "send", exact: true }).click();

  // The user message only renders if `appendUserMessage` → `newId()` → randomUUID() survived.
  // This is the assertion that makes the test non-vacuous.
  await page.getByText(MESSAGE).first().waitFor({ state: "visible", timeout: 30_000 });
  log("chat send rendered the user message — reducer ran clean");

  // Remix's root boundary renders this when a route throws.
  if (await page.getByText("Application Error").count()) {
    fail("the app rendered Remix's 'Application Error' boundary");
  }

  const violations = await cspViolations();
  if (violations.length) fail(`CSP violations: ${[...new Set(violations)].join("; ")}`);

  if (pageErrors.length) {
    fail(`uncaught page errors:\n    ${[...new Set(pageErrors)].join("\n    ")}`);
  }

  // A CSP/module failure previously drove the reload-on-failure handler into a loop.
  if (loadCount > 5) fail(`page loaded ${loadCount} times — looks like a reload loop`);

  if (!process.exitCode) log("PASS — wizard completed, chat send clean, no CSP violations");
} catch (err) {
  fail(err.message);
  await page.screenshot({ path: "browser-smoke-failure.png", fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}
