import { completeOrSignIn, expect, openProductionRoot, test } from "./fixtures";

const password = "smoke-password-123";
const email = "smoke@tulipfarm.test";

test("sign-in survives a full reload", async ({ page }) => {
  await openProductionRoot(page);
  await page.context().clearCookies();
  await openProductionRoot(page);
  await page.waitForURL(/\/login\b/);
  await page.getByLabel("email").fill(email);
  await page.getByLabel("password").fill(password);
  await page.getByRole("button", { name: /Sign in/i }).click();
  await page.waitForURL(/\/$/);
  await expect(page.getByLabel("Message")).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Message")).toBeVisible();
});

test("renders TSP Artifacts under the production CSP", async ({ page }) => {
  await openProductionRoot(page);
  // Firefox loses a goto issued while the SPA is still resolving its own first client-side
  // navigation — the redirect to "/" wins and the request is dropped. Wait for the shell first.
  await expect(page.getByLabel("Message")).toBeVisible();
  const response = await page
    .goto("/dev/surfaces", { waitUntil: "domcontentloaded" })
    .catch(() => null);
  if (response?.status() === 200) {
    expect(response.headers()["content-security-policy"] ?? "").toMatch(/script-src[^;]*'sha256-/);
  }
  await expect(page.getByRole("heading", { name: "Tulip Surface Protocol" })).toBeVisible();
  await expect(page.getByText("Healthy")).toBeVisible();
  await expect(page.getByText("Acme")).toBeVisible();
  await expect(page.getByText("Globex")).toBeVisible();
});

test("persists a sent Chat Message across a deep-link reload", async ({ page }) => {
  // `POST /api/v1/chat` is an SSE stream and the server flushes nothing until the model answers,
  // so with no provider configured there is no bubble, no navigation, and no sidebar refresh to
  // wait on — the Message is persisted, but nothing about it is observable in the browser. Gated
  // like the other two provider-dependent journeys rather than asserted around.
  test.skip(process.env.E2E_AGENTIC !== "1", "agentic provider harness is opt-in");
  await openProductionRoot(page);
  await completeOrSignIn(page);
  const message = `browser smoke test message ${Date.now()}`;
  const composer = page.getByLabel("Message");
  await composer.click();
  await page.keyboard.type(message);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByRole("main").getByText(message).first()).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("main").getByText(message).first()).toBeVisible();
});
