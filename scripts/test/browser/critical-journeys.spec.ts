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
  await openProductionRoot(page);
  await completeOrSignIn(page);
  const message = `browser smoke test message ${Date.now()}`;
  const composer = page.getByLabel("Message");
  await composer.click();
  await page.keyboard.type(message);
  await page.getByRole("button", { name: "send", exact: true }).click();
  await expect(page.getByText(message).first()).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText(message).first()).toBeVisible();
});
