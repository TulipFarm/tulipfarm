import { completeOrSignIn, configureMockLlm, expect, openProductionRoot, test } from "./fixtures";

test.describe("product CRUD journeys", () => {
  test("creates, edits, lists, and deletes a Resource record", async ({ page }) => {
    await openProductionRoot(page);
    await completeOrSignIn(page);
    const type = `e2e-resource-${Date.now()}`;
    const label = `first-${Date.now()}`;
    const edited = `${label}-edited`;

    await page.goto("/resources/new");
    await page.getByLabel("type name").fill(type);
    await page.getByLabel("field 1 name").fill("label");
    await page.getByRole("button", { name: "Create type" }).click();
    await page.waitForURL(new RegExp(`/resources/${type}$`));
    await page.getByRole("link", { name: new RegExp(`New ${type}`) }).click();
    await page.getByLabel("label").fill(label);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText(label)).toBeVisible();
    await page.getByRole("link", { name: "Edit" }).click();
    await page.getByLabel("label").fill(edited);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(edited)).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await page.waitForURL(new RegExp(`/resources/${type}$`));
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete type" }).click();
    await page.waitForURL("/resources");
    await expect(page.getByText(type)).not.toBeVisible();
  });

  test("creates, edits, authors, and deletes a Knowledge space and page", async ({ page }) => {
    await openProductionRoot(page);
    await completeOrSignIn(page);
    const name = `e2e-space-${Date.now()}`;
    const path = "e2e/page";
    await page.goto("/knowledge/spaces/new");
    await page.getByLabel("name").fill(name);
    await page.getByLabel("description").fill("browser CRUD fixture");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
    const spaceUrl = page.url();
    await page.getByRole("link", { name: "New page", exact: true }).click();
    await page.getByLabel("path").fill(path);
    await page.getByRole("button", { name: "raw" }).click();
    await page.getByLabel("content").fill("---\ntitle: E2E page\n---\n\ncreated");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("E2E page")).toBeVisible();
    await page.getByRole("link", { name: "edit" }).click();
    await page.getByRole("button", { name: "raw" }).click();
    await page.getByLabel("content").fill("---\ntitle: E2E page\n---\n\nupdated");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("updated")).toBeVisible();
    await page.goto(spaceUrl);
    await page.getByRole("link", { name: "Space settings" }).click();
    await page.getByLabel("description").fill("edited fixture");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("edited fixture")).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await page.waitForURL("/knowledge");
    await expect(page.getByText(name)).not.toBeVisible();
  });

  test("exposes Skills, Routines, Integrations, and Approvals product surfaces", async ({
    page,
  }) => {
    await openProductionRoot(page);
    await completeOrSignIn(page);
    for (const [path, marker] of [
      ["/skills", "skills"],
      ["/routines", "routines"],
      ["/integrations", "integrations"],
      ["/inbox", "Approvals"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByText(new RegExp(marker, "i")).first()).toBeVisible();
    }
  });

  test("creates a Resource through the real Chat agent tool loop", async ({ page }) => {
    await openProductionRoot(page);
    await completeOrSignIn(page);
    await configureMockLlm(page);
    await page.goto("/");
    await page.getByLabel("Message").fill("Create a resource type for the E2E resource test.");
    await page.getByRole("button", { name: "send", exact: true }).click();
    await expect(page.getByText(/Completed by the deterministic E2E model/i)).toBeVisible({
      timeout: 60_000,
    });
    await page.goto("/resources");
    await expect(page.getByText(/agent-resource-/).first()).toBeVisible({ timeout: 30_000 });
  });

  test("creates a Knowledge space through the real Chat agent tool loop", async ({ page }) => {
    await openProductionRoot(page);
    await completeOrSignIn(page);
    await configureMockLlm(page);
    await page.goto("/");
    await page.getByLabel("Message").fill("Create a knowledge space for the E2E test.");
    await page.getByRole("button", { name: "send", exact: true }).click();
    await expect(page.getByText(/Completed by the deterministic E2E model/i)).toBeVisible({
      timeout: 60_000,
    });
    await page.goto("/knowledge");
    await expect(page.getByText(/agent-space-/).first()).toBeVisible({ timeout: 30_000 });
  });
});
