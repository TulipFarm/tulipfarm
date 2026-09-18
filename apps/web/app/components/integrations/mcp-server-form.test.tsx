import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { configureMcpIntegration } from "~/lib/mcp-integrations";
import { McpServerForm } from "./mcp-server-form";

vi.mock("~/lib/mcp-integrations", () => ({ configureMcpIntegration: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

test("persists a disabled remote server without approving capabilities", async () => {
  const saved = vi.fn();
  const server = {
    server: {
      id: "support",
      label: "Support",
      transport: { type: "streamable-http" as const, url: "https://mcp.example.com/" },
    },
    enabled: false,
    reviewed: { tools: [], resources: [], prompts: [] },
  };
  vi.mocked(configureMcpIntegration).mockResolvedValue(server);
  render(<McpServerForm onSaved={saved} />);
  await userEvent.type(screen.getByLabelText("Integration ID"), "support");
  await userEvent.type(screen.getByLabelText("Display name"), "Support");
  await userEvent.type(screen.getByLabelText("Remote MCP URL"), "https://mcp.example.com/");
  await userEvent.click(screen.getByRole("button", { name: "Add server" }));
  expect(configureMcpIntegration).toHaveBeenCalledWith("support", {
    server: {
      ...server.server,
      authentication: { type: "token", sharedAllowed: false },
    },
    enabled: false,
  });
  expect(saved).toHaveBeenCalledWith(server);
});

test("catalog OAuth setup keeps Slack sharing disabled", async () => {
  render(
    <McpServerForm
      onSaved={vi.fn()}
      suggestion={{
        id: "slack-mcp",
        label: "Slack",
        transport: { type: "streamable-http", url: "https://mcp.slack.com/mcp" },
        authentication: "oauth",
      }}
    />
  );
  expect(
    screen.getByRole("checkbox", { name: "Permit admin-managed shared accounts" })
  ).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Add server" }));
  expect(configureMcpIntegration).toHaveBeenCalledWith("slack-mcp", {
    server: {
      id: "slack-mcp",
      label: "Slack",
      transport: { type: "streamable-http", url: "https://mcp.slack.com/mcp" },
      authentication: { type: "oauth", sharedAllowed: false },
    },
    enabled: false,
  });
});

test("local token setup submits only reviewed environment names, not credential values", async () => {
  render(
    <McpServerForm
      onSaved={vi.fn()}
      suggestion={{
        id: "github-local",
        label: "GitHub",
        transport: {
          type: "stdio",
          image: `ghcr.io/github/github-mcp-server@sha256:${"a".repeat(64)}`,
          command: "/server",
          args: [],
          allowedEgress: ["api.github.com"],
        },
      }}
    />
  );
  expect(
    screen.getByText(/Production requires operator-configured Kata VM isolation/)
  ).toBeInTheDocument();
  await userEvent.type(
    screen.getByLabelText("Credential environment names"),
    "GITHUB_PERSONAL_ACCESS_TOKEN"
  );
  await userEvent.click(screen.getByRole("button", { name: "Add server" }));
  expect(configureMcpIntegration).toHaveBeenCalledWith(
    "github-local",
    expect.objectContaining({
      server: expect.objectContaining({
        authentication: {
          type: "token",
          environment: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
          sharedAllowed: false,
        },
      }),
    })
  );
});

test("does not report a failed server write as saved", async () => {
  const saved = vi.fn();
  vi.mocked(configureMcpIntegration).mockRejectedValue(
    new Error("This destination is not allowed.")
  );
  render(
    <McpServerForm
      onSaved={saved}
      suggestion={{
        id: "support",
        label: "Support",
        transport: { type: "streamable-http", url: "https://mcp.example.com/" },
      }}
    />
  );
  await userEvent.click(screen.getByRole("button", { name: "Add server" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("This destination is not allowed.");
  expect(saved).not.toHaveBeenCalled();
});

test("rejects credentials in a URL before sending server configuration", async () => {
  render(
    <McpServerForm
      onSaved={vi.fn()}
      suggestion={{
        id: "support",
        label: "Support",
        transport: { type: "streamable-http", url: "https://token:secret@mcp.example.com/" },
      }}
    />
  );
  await userEvent.click(screen.getByRole("button", { name: "Add server" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("without credentials");
  expect(configureMcpIntegration).not.toHaveBeenCalled();
});

test.each(["github", "slack"])(
  "refuses reserved native ID %s without renaming or submitting it",
  async (id) => {
    const saved = vi.fn();
    render(
      <McpServerForm
        onSaved={saved}
        suggestion={{
          id,
          label: "Provider MCP",
          transport: { type: "streamable-http", url: "https://mcp.example.com/" },
        }}
      />
    );
    expect(
      screen.getByText(/github and slack are reserved for native channels/)
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("reserved native channel IDs");
    expect(screen.getByLabelText("Integration ID")).toHaveValue(id);
    expect(configureMcpIntegration).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  }
);
