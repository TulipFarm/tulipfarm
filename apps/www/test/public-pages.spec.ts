import { expect, type Page, test } from "@playwright/test";
import { DOCS_URL, SITE_URL } from "@tulipfarm/constants/site";

async function chooseDocker(page: Page, database: "bundled" | "managed") {
  await page.getByRole("radio", { name: /^Docker Compose/ }).click();
  await expect(
    page.getByRole("heading", { name: "Where does PostgreSQL live?", exact: true })
  ).toBeFocused();
  await page
    .getByRole("radio", {
      name:
        database === "bundled"
          ? "The bundled Postgres container"
          : "A managed PostgreSQL 17 I already run",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Next question", exact: true }).click();
  await page.getByRole("button", { name: /^Show \d+ steps$/ }).click();
}

test("puts guided setup and the assistant prompt within reach on entry", async ({ page }) => {
  await page.goto("/deploy");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Make TulipFarm yours.");
  await expect(page.getByRole("link", { name: "Guided setup", exact: true })).toBeInViewport();
  await expect(page.getByRole("radio", { name: /^Docker Compose/ })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Copy prompt", exact: true })).toBeInViewport();
  await expect(page.getByRole("radio")).toHaveCount(5);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${SITE_URL}/deploy`);
});

for (const database of ["bundled", "managed"] as const) {
  test(`preserves the ${database} database checklist and local progress`, async ({ page }) => {
    await page.goto("/deploy");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));

    await chooseDocker(page, database);
    await expect(
      page.getByRole("heading", { name: "Your setup checklist", exact: true })
    ).toBeFocused();
    await expect(
      page.getByRole("heading", {
        name: database === "bundled" ? "Start the stack" : "Start against a managed database",
        exact: true,
      })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: database === "bundled" ? "Start against a managed database" : "Start the stack",
        exact: true,
      })
    ).toHaveCount(0);
    await expect(
      page.getByText(`curl -fsSLO ${SITE_URL}/docker-compose.yml`, { exact: true })
    ).toBeVisible();
    await page.getByRole("checkbox", { name: /Download the Compose file/ }).check();
    await expect(page.getByRole("progressbar", { name: "Steps marked done" })).toHaveAttribute(
      "aria-valuenow",
      "1"
    );
    await page.getByRole("checkbox", { name: /Download the Compose file/ }).uncheck();
    await expect(page.getByRole("progressbar", { name: "Steps marked done" })).toHaveAttribute(
      "aria-valuenow",
      "0"
    );
    await expect(page.locator('input:not([type="radio"]):not([type="checkbox"])')).toHaveCount(0);
    expect(requests).toEqual([]);
  });
}

test("keeps community and undocumented platforms distinct", async ({ page }) => {
  await page.goto("/deploy");
  await page.getByRole("radio", { name: /^Kubernetes/ }).click();
  await page.getByRole("button", { name: "Next question", exact: true }).click();
  await page.getByRole("button", { name: /^Show \d+ steps$/ }).click();
  await expect(page.getByText("Not verified end to end.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your setup checklist" })).toBeVisible();
  await page
    .locator('[data-stage="platform"]')
    .getByRole("button", { name: /^Change/ })
    .click();
  await page.getByRole("radio", { name: /^Somewhere else/ }).click();
  await expect(page.getByRole("heading", { name: "Use the installation prompt." })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy prompt", exact: true })).toHaveCount(1);
});

test("copies the exact deployment prompt and exposes clipboard failures", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/deploy");
  const copyButton = page.locator("#assistant-setup").getByRole("button");
  await copyButton.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `Deploy TulipFarm on my own infrastructure.\nRead ${SITE_URL}/deploy.txt and follow it exactly.\nAsk me the questions it lists before you run anything.`
  );
  await expect(copyButton).toHaveText("Copied");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException("Clipboard permission denied", "NotAllowedError");
        },
      },
    });
  });
  await copyButton.click();
  await expect(page.locator("#assistant-setup").getByRole("alert")).toContainText(
    "Select and copy the prompt text below."
  );
  await expect(page.locator("#assistant-setup pre")).toContainText(`${SITE_URL}/deploy.txt`);
});

for (const scripts of ["disabled", "failed"] as const) {
  test(`keeps setup useful when scripts are ${scripts}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      baseURL,
      javaScriptEnabled: scripts !== "disabled",
    });
    try {
      const page = await context.newPage();
      if (scripts === "failed") {
        await page.route("**/*.js", (route) => route.abort());
      }
      await page.goto("/deploy");
      await expect(page.getByRole("radio", { name: /^Docker Compose/ })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Copy prompt", exact: true })).toBeDisabled();
      await expect(
        page.getByText("Setup controls need JavaScript.", { exact: false })
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Read the setup docs", exact: true })
      ).toHaveAttribute("href", `${DOCS_URL}/self-hosting`);
      await expect(page.locator("#assistant-setup pre")).toContainText(`${SITE_URL}/deploy.txt`);
      await expect(
        page.getByRole("link", { name: "Read the deployment guide", exact: true })
      ).toHaveAttribute("href", "/deploy.txt");
    } finally {
      await context.close();
    }
  });
}

test("keeps the setup journey readable on a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/deploy");
  await page.getByRole("link", { name: "Use an AI assistant", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy prompt", exact: true })).toBeInViewport();
  await page.getByRole("link", { name: "Guided setup", exact: true }).click();
  await chooseDocker(page, "bundled");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(
    await page.evaluate(
      () => document.getAnimations().filter((animation) => animation.playState === "running").length
    )
  ).toBe(0);
});

test("provides a real 404 with useful exits and consistent share metadata", async ({ page }) => {
  const response = await page.goto("/a-page-that-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found.");
  await expect(page.getByRole("main").getByRole("link", { name: "Go home" })).toHaveAttribute(
    "href",
    "/"
  );
  await expect(page.getByRole("main").getByRole("link", { name: "Read the docs" })).toHaveAttribute(
    "href",
    `${DOCS_URL}/`
  );
  await page.getByRole("main").getByRole("link", { name: "Go home" }).click();
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    "Your business. Built in chat."
  );
  await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute(
    "content",
    "Your business. Built in chat."
  );
});
