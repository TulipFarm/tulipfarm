import { expect, test } from "@playwright/test";
import { DOCS_URL, SITE_URL } from "@tulipfarm/constants/site";

test("ships the value proposition, prepared example, and primary action in HTML", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your business. Built in chat.");
  const demo = page.locator("#examples");
  await expect(demo.getByText("Prepared example", { exact: true })).toBeVisible();
  await expect(
    demo.getByText("Illustrated flow. Real product components. Fixed sample data.")
  ).toBeVisible();
  const primaryAction = page
    .getByRole("main")
    .getByRole("link", { name: "Start building" })
    .first();
  await expect(primaryAction).toBeInViewport();
  await expect(primaryAction).toHaveAttribute("href", "/deploy");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", SITE_URL);
  await expect(
    page
      .getByRole("navigation", { name: "Main", exact: true })
      .getByRole("link", { name: "Docs", exact: true })
  ).toHaveAttribute("href", `${DOCS_URL}/`);
  await expect(
    demo.getByRole("heading", { name: "Put the first customer in place." })
  ).toBeVisible();
  await expect(demo.getByRole("cell", { name: "Maple Studio", exact: true })).toBeVisible();
  await expect(demo.getByRole("cell", { name: "Maple Studio", exact: true })).toBeInViewport();
  await demo.getByText("See the actual chat interface", { exact: true }).click();
  const capture = demo.getByRole("img", { name: /^TulipFarm chat with a prepared request:/ });
  await expect(capture).toHaveJSProperty(
    "src",
    new URL("/images/examples/customers.webp", page.url()).href
  );
  await expect(capture).toBeVisible();
  expect(
    await capture.evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth > 0)
  ).toBe(true);
  await expect(page.getByRole("link", { name: "See what you can build" })).toHaveAttribute(
    "href",
    "#examples"
  );
  expect(errors).toEqual([]);
});

test("switches examples and cancels an in-progress replay without stale results", async ({
  page,
}) => {
  await page.goto("/");
  await page.clock.install();
  const demo = page.locator("#examples");
  await demo.getByRole("button", { name: "Set up support", exact: true }).click();
  await demo.getByRole("button", { name: "Replay story", exact: true }).click();
  await expect(demo.getByRole("button", { name: "Pause story" })).toBeVisible();
  await demo.getByRole("button", { name: "Track customers", exact: true }).click();
  await page.clock.runFor(6000);
  await expect(
    demo.getByRole("heading", { name: "Put the first customer in place." })
  ).toBeVisible();
  await expect(demo.getByRole("button", { name: "Use", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(demo.getByRole("button", { name: "Replay story", exact: true })).toBeVisible();
  await expect(demo.getByText("Needs human review", { exact: true })).toHaveCount(0);
  await demo.getByRole("button", { name: "Set up support", exact: true }).click();
  await demo.getByText("See the actual chat interface", { exact: true }).click();
  await expect(
    demo.getByRole("img", { name: /^TulipFarm chat with a prepared request:/ })
  ).toHaveJSProperty("src", new URL("/images/examples/support.webp", page.url()).href);
  await demo.getByRole("button", { name: "Replay story", exact: true }).click();
  await page.clock.runFor(1900);
  await demo.getByRole("button", { name: "Pause story", exact: true }).click();
  await page.clock.runFor(6000);
  await expect(
    demo.getByRole("heading", { name: "Build the tracker before the agent." })
  ).toBeVisible();
  await demo.getByRole("button", { name: "Replay story", exact: true }).click();
  await page.clock.runFor(4000);
  await expect(demo.getByRole("heading", { name: "Hand over the routine work." })).toBeVisible();
  await expect(demo.getByText("Needs human review", { exact: true })).toBeVisible();
  await demo.getByRole("button", { name: "Reset example" }).click();
  await expect(demo.getByRole("heading", { name: "Give your agent a useful job." })).toBeVisible();
});

test("offers a full keyboard path and an immediate reduced-motion result", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const choice = page.getByRole("button", { name: "Make work repeat", exact: true });
  await choice.focus();
  await page.keyboard.press("Enter");
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  const replay = page.getByRole("button", { name: "Replay story", exact: true });
  await replay.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("heading", { name: "See what needs your attention." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  expect(
    await page.evaluate(
      () => document.getAnimations().filter((animation) => animation.playState === "running").length
    )
  ).toBe(0);
  await page.getByRole("button", { name: "Reset example" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Describe the work that keeps coming back." })
  ).toBeVisible();
});

test("keeps demo interactions entirely local", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  for (const label of ["Set up support", "Make work repeat", "Track customers"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("button", { name: "Use", exact: true }).click();
    await page.getByText("See the actual chat interface", { exact: true }).click();
  }
  expect(requests).toEqual([]);
});

test("remains readable at the agreed mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".chat-capture")).toBeHidden();
  await expect(page.locator(".story-request")).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: "Start building" }).first()
  ).toBeInViewport();
  for (const label of ["Track customers", "Set up support", "Make work repeat"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("button", { name: "Use", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390
    );
  }
  await page.getByLabel("Navigation menu").click();
  await expect(
    page
      .getByRole("navigation", { name: "Mobile", exact: true })
      .getByRole("link", { name: "Docs", exact: true })
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page
    .getByRole("navigation", { name: "Mobile", exact: true })
    .getByRole("link", { name: "Examples", exact: true })
    .click();
  await expect(page.getByRole("banner")).not.toBeInViewport();
  await expect(page.getByRole("button", { name: "Track customers", exact: true })).toBeInViewport();
});

test("preserves a useful website when JavaScript is disabled", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Your business.");
    await expect(page.locator("noscript")).toBeVisible();
    await expect(page.locator("noscript p")).toContainText("Enable JavaScript to switch examples.");
    await expect(page.getByRole("button", { name: "Replay story", exact: true })).toBeDisabled();
    await expect(
      page.locator("#examples").getByRole("cell", { name: "Maple Studio", exact: true })
    ).toBeVisible();
    await page.getByText("Where does my data go?", { exact: false }).click();
    await expect(
      page.getByRole("link", { name: "Read the data and telemetry policy" })
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("keeps a readable first frame and recovery guidance when interaction scripts fail", async ({
  page,
}) => {
  await page.route("**/*", (route) =>
    route.request().resourceType() === "script" ? route.abort() : route.continue()
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Put the first customer in place." })
  ).toBeVisible();
  await expect(
    page.getByText(
      "Static preview. Interactive controls need JavaScript; enable it or reload to try again."
    )
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Replay story", exact: true })).toBeDisabled();
  await page.getByRole("main").getByRole("link", { name: "Start building" }).first().click();
  await expect(page).toHaveURL(/\/deploy\/?$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("keeps the request and result readable if the chat capture fails", async ({ page }) => {
  await page.route("**/images/examples/*.webp", (route) => route.abort());
  await page.goto("/");
  const demo = page.locator("#examples");
  await demo.getByText("See the actual chat interface", { exact: true }).click();
  await expect(
    demo.getByText(
      "The chat image could not load. The prepared request and result are still available above."
    )
  ).toBeVisible();
  await expect(demo.locator(".story-request")).toBeVisible();
  await expect(demo.getByRole("cell", { name: "Maple Studio", exact: true })).toBeVisible();
  await demo.getByRole("button", { name: "Set up support", exact: true }).click();
  await expect(demo.getByText("Needs human review", { exact: true })).toBeVisible();
});

test("takes Start building to the guided deployment page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("main").getByRole("link", { name: "Start building" }).first().click();
  await expect(page).toHaveURL(/\/deploy\/?$/);
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator(`a[href^="${DOCS_URL}"]`).first()).toBeVisible();
});

test("publishes permanent documentation redirects and real machine-readable downloads", async ({
  request,
}) => {
  for (const [legacyPath, docsPath] of [
    ["/docs", "/"],
    ["/docs.html", "/"],
    ["/docs/using-tulipfarm/agents?source=legacy", "/using-tulipfarm/agents?source=legacy"],
    ["/api/search", "/api/search"],
    ["/llms.txt", "/llms.txt"],
    ["/llms-full.txt", "/llms-full.txt"],
    ["/llms.mdx/docs/self-hosting/install", "/llms.mdx/docs/self-hosting/install"],
    ["/og/docs/self-hosting/install/image.png", "/og/docs/self-hosting/install/image.png"],
  ] as const) {
    const redirect = await request.get(legacyPath, { maxRedirects: 0 });
    expect(redirect.status(), legacyPath).toBe(301);
    expect(redirect.headers().location, legacyPath).toBe(`${DOCS_URL}${docsPath}`);
  }

  for (const path of [
    "/install.sh",
    "/uninstall.sh",
    "/install.ps1",
    "/docker-compose.yml",
    "/env.example",
    "/deploy.txt",
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"], path).toContain("text/plain");
    expect(await response.text(), path).not.toMatch(/<!doctype html|self\.__next_f|^\d+:/i);
  }
  const image = await request.get("/opengraph-image.png");
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toContain("image/png");
  const missing = await request.get("/this-page-does-not-exist");
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain("Page not found");
});
