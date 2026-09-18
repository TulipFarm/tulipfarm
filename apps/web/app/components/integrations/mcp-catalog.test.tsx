import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { McpCatalogEntry } from "~/lib/mcp-integrations";
import { McpCatalog } from "./mcp-catalog";

const entry: McpCatalogEntry = {
  id: "slack",
  name: "Slack",
  publisher: "Slack",
  url: "https://mcp.slack.com/mcp",
  publisherEvidence: "https://docs.slack.dev/ai/slack-mcp-server/",
  authentication: ["oauth"],
  setup: ["Register an eligible Slack app."],
  limitations: ["Personal user authorization cannot be shared."],
  knowledgeSync: "excluded",
};

function mount(isAdmin: boolean, configured = false) {
  const setup = vi.fn();
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <McpCatalog
          entries={[entry]}
          configuredServers={
            configured
              ? [
                  {
                    server: {
                      id: "slack-mcp",
                      label: "Slack",
                      transport: { type: "streamable-http", url: entry.url },
                    },
                    enabled: false,
                    reviewed: { tools: [], resources: [], prompts: [] },
                  },
                ]
              : []
          }
          isAdmin={isAdmin}
          onSetup={setup}
        />
      ),
    },
  ]);
  render(<Stub />);
  return setup;
}

test("official catalog setup is explicit and excludes Slack Knowledge sync", async () => {
  const setup = mount(true);
  await userEvent.click(await screen.findByText("Setup and compatibility"));
  expect(screen.getByText("Knowledge sync is excluded for this provider.")).toBeVisible();
  expect(setup).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Set up Slack" }));
  expect(setup).toHaveBeenCalledWith(entry);
});

test("configured catalog entries route to management instead of overwriting settings", async () => {
  mount(true, true);
  expect(await screen.findByRole("link", { name: "Manage Slack" })).toHaveAttribute(
    "href",
    "/integrations/slack-mcp"
  );
  expect(screen.queryByRole("button", { name: "Set up Slack" })).not.toBeInTheDocument();
});

test("members can read setup limitations without gaining server configuration controls", async () => {
  mount(false);
  expect(await screen.findByText("An admin can add this server")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Set up Slack" })).not.toBeInTheDocument();
});
