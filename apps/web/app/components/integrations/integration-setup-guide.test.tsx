import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import type { McpCatalogEntry } from "~/lib/mcp-integrations";
import { IntegrationSetupGuide } from "./integration-setup-guide";

const slack: McpCatalogEntry = {
  id: "slack",
  name: "Slack",
  publisher: "Slack",
  url: "https://mcp.slack.com/mcp",
  publisherEvidence: "https://docs.slack.dev/ai/slack-mcp-server/",
  authentication: ["oauth"],
  setup: ["Register an eligible app."],
  limitations: ["Shared accounts are not allowed."],
  knowledgeSync: "excluded",
};

test("keeps capabilities and provider instructions in optional setup help", async () => {
  render(<IntegrationSetupGuide entry={slack} />);
  expect(screen.getByText(/A bot token cannot be used instead/)).not.toBeVisible();
  await userEvent.click(screen.getByText("Setup help · Slack"));
  const capabilities = screen.getByRole("region", { name: "Slack capabilities" });
  expect(within(capabilities).getByText("Messages")).toBeVisible();
  expect(
    within(capabilities).getByText(/Initial setup requires approval for every Tool call/)
  ).toBeVisible();
  expect(screen.getByText(/A bot token cannot be used instead/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Provider setup guide" })).toHaveAttribute(
    "href",
    slack.publisherEvidence
  );
});

test("keeps technical requirements available without leading with the endpoint", async () => {
  render(<IntegrationSetupGuide entry={slack} />);
  expect(screen.getByText(slack.url)).not.toBeVisible();
  await userEvent.click(screen.getByText("Setup help · Slack"));
  await userEvent.click(screen.getByText("Technical requirements"));
  expect(screen.getByText(slack.url)).toBeVisible();
  expect(screen.getByText("Knowledge sync is not available for this integration.")).toBeVisible();
  expect(screen.getByText("Shared accounts are not allowed.")).toBeVisible();
});

test("management can show capability context without repeating initial setup instructions", async () => {
  render(<IntegrationSetupGuide entry={slack} showInstructions={false} />);
  await userEvent.click(screen.getByText("Setup help · Slack"));
  expect(screen.getByRole("region", { name: "Slack capabilities" })).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Slack setup instructions" })
  ).not.toBeInTheDocument();
});
