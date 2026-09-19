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
  const manage = vi.fn();
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
          connections={{
            "slack-mcp": {
              accounts: [],
              configuration: {
                authentication: "oauth",
                requiredSlots: [],
                sharedAllowed: false,
                definitionDigest: "current",
              },
              error: null,
            },
          }}
          onSetup={setup}
          onManage={manage}
        />
      ),
    },
  ]);
  render(<Stub />);
  return { setup, manage };
}

test("the catalog has one clear Connect action without inline setup instructions", async () => {
  const { setup } = mount(true);
  expect(await screen.findByRole("heading", { name: "Integrations", level: 2 })).toBeVisible();
  expect(screen.queryByText("Official MCP servers")).not.toBeInTheDocument();
  expect(screen.queryByText("Before you connect")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Connect Slack" })).toHaveTextContent(/^Connect$/);
  expect(setup).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
  expect(setup).toHaveBeenCalledWith(entry);
});

test("unconnected catalog entries resume their existing definition without overwriting settings", async () => {
  const { manage, setup } = mount(true, true);
  const button = await screen.findByRole("button", { name: "Connect Slack" });
  expect(button).toHaveTextContent(/^Connect$/);
  await userEvent.click(button);
  expect(manage).toHaveBeenCalledWith(
    expect.objectContaining({ server: expect.objectContaining({ id: "slack-mcp" }) }),
    entry
  );
  expect(setup).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Manage Slack" })).not.toBeInTheDocument();
});

test("members can open provider information while the catalog explains admin setup", async () => {
  const { setup } = mount(false);
  expect(await screen.findByText("An admin needs to finish setup.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
  expect(setup).toHaveBeenCalledWith(entry);
});
