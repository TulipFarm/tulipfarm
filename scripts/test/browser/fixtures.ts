import { test as base, expect, type Page } from "@playwright/test";

type Diagnostics = {
  readonly pageErrors: string[];
  readonly cspViolations: string[];
  loadCount: number;
};

export const test = base.extend<{ diagnostics: Diagnostics }>({
  diagnostics: async ({ page, context }, use, testInfo) => {
    const diagnostics: Diagnostics = { pageErrors: [], cspViolations: [], loadCount: 0 };

    await context.exposeBinding("__recordCspViolation", (_source, value: unknown) => {
      diagnostics.cspViolations.push(String(value));
    });
    await context.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        const record = (window as Window & { __recordCspViolation?: (value: string) => void })
          .__recordCspViolation;
        record?.(`${event.violatedDirective} blocked ${event.blockedURI || "inline"}`);
      });
    });

    // Keep browser-visible provider calls deterministic. Product/API traffic remains real; only
    // calls made directly to a provider endpoint are fulfilled with a minimal OpenAI-compatible
    // response so a test can never spend credentials or hit the network accidentally.
    await page.route(
      /https:\/\/(api\.openai\.com|api\.anthropic\.com|api\.openai\.com\/v1)\/.*/,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "e2e-mock",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "E2E mocked response" } }],
          }),
        });
      }
    );

    page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
    page.on("load", () => {
      diagnostics.loadCount += 1;
    });

    await use(diagnostics);

    const unique = (values: readonly string[]) => [...new Set(values)];
    if (diagnostics.cspViolations.length > 0) {
      await testInfo.attach("csp-violations", {
        body: unique(diagnostics.cspViolations).join("\n"),
        contentType: "text/plain",
      });
    }
    expect(diagnostics.cspViolations, "CSP violations").toEqual([]);
    expect(unique(diagnostics.pageErrors), "uncaught page errors").toEqual([]);
    expect(diagnostics.loadCount, "reload-loop guard").toBeLessThanOrEqual(5);
  },
});

export { expect };

// The Business's second, ordinary (non-admin) member — see second-member.setup.ts. Shared between
// that bootstrap and the "colleague" spec so both agree on the one account without duplicating it.
export const COLLEAGUE_EMAIL = "colleague@tulipfarm.test";
export const COLLEAGUE_PASSWORD = "colleague-password-123";

export async function openProductionRoot(page: Page): Promise<void> {
  const response = await page.goto("/", { waitUntil: "domcontentloaded" }).catch(() => null);
  const headers = response?.headers() ?? {};
  const csp = headers["content-security-policy"] ?? "";
  if (response?.status() === 200) {
    expect(csp, "production CSP header").toMatch(/script-src[^;]*'sha256-/);
    expect(csp, "script CSP must not use unsafe-inline").not.toMatch(
      /script-src[^;]*'unsafe-inline'/
    );
  }
  const html = response?.status() === 200 ? await response.text() : "";
  expect(html ?? "", "built bundle marker").not.toContain("/@vite/client");
  if (process.env.BROWSER_SMOKE_REQUIRE_INSECURE === "1") {
    const origin = new URL(page.url());
    expect(origin.protocol, "browser smoke origin").toBe("http:");
    expect(origin.hostname, "browser smoke origin").toMatch(/^\d{1,3}(?:\.\d{1,3}){3}$/);
    expect(origin.hostname, "browser smoke must not use localhost").not.toBe("127.0.0.1");
    expect(origin.hostname, "browser smoke must not use localhost").not.toBe("0.0.0.0");
    expect(await page.evaluate(() => window.isSecureContext), "secure-context guard").toBe(false);
    expect(
      await page.evaluate(() => typeof crypto.randomUUID),
      "secure-context API must be unavailable"
    ).toBe("undefined");
  }
}

export async function completeOrSignIn(page: Page): Promise<void> {
  if (!/\/(setup|login)\b/.test(page.url())) {
    await expect(page.getByLabel("Message")).toBeVisible();
    return;
  }
  await page.waitForURL(/\/(setup|login)\b/, { timeout: 60_000 });
  const onSetup = page.url().includes("/setup");
  const email = "smoke@tulipfarm.test";
  const password = "smoke-password-123";
  const businessName = "Smoke Test Co";

  if (onSetup) {
    // One question per screen: name, email, password, business name. Only the last screen
    // renders "Finish", so every earlier answer has to be submitted with "Continue".
    await page.locator('input[type="text"]').fill("Smoke Test");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator('input[type="email"]').fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator('input[type="text"]').fill(businessName);
    await page.getByRole("button", { name: "Finish" }).click();
  } else {
    await page.getByLabel("email").fill(email);
    await page.getByLabel("password").fill(password);
    await page.getByRole("button", { name: /Sign in/i }).click();
  }

  await page.waitForURL(/\/$/, { timeout: 60_000 });
}

/** Configure the real Settings surfaces to use the installer-local mock provider. */
export async function configureMockLlm(page: Page): Promise<void> {
  const baseUrl = process.env.E2E_LLM_BASE_URL;
  if (!baseUrl) throw new Error("E2E_LLM_BASE_URL is required for agentic E2E tests");
  await page.goto("/settings/secrets");
  const providerPicker = page.getByLabel("secret provider");
  if (await providerPicker.locator('option[value="openai-compatible"]').count()) {
    await providerPicker.selectOption("openai-compatible");
    await page.getByLabel("openai-compatible api_key").fill("e2e-no-network-key");
    await page.getByLabel("openai-compatible base_url").fill(baseUrl);
    await page.getByRole("button", { name: "Save provider" }).click();
  }
  await page.goto("/settings/llm");
  for (const tier of ["quick", "standard", "complex"]) {
    const fieldset = page.locator("fieldset").filter({ hasText: `[${tier}]` });
    const provider = page.getByLabel(`${tier} provider 1 provider`);
    if (!(await provider.count())) {
      await fieldset.getByRole("button", { name: /add provider/i }).click();
    }
    await provider.selectOption("openai-compatible");
    await page.getByLabel(`${tier} provider 1 model`).fill("e2e-mock");
  }
  await page.getByRole("button", { name: "Save" }).click();
}
