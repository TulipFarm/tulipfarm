import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { configureMcpIntegration } from "~/lib/mcp-integrations";
import { McpServerForm } from "./mcp-server-form";

vi.mock("~/lib/mcp-integrations", () => ({ configureMcpIntegration: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(configureMcpIntegration).mockImplementation(async (_id, input) => ({
    server: input.server,
    enabled: input.enabled ?? false,
    reviewed: { tools: [], resources: [], prompts: [] },
  }));
});

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
  await userEvent.type(screen.getByLabelText("Name"), "Support");
  expect(screen.getByLabelText("Integration ID")).toHaveValue("support");
  expect(screen.getByLabelText("Integration ID")).not.toBeVisible();
  await userEvent.type(screen.getByLabelText("Integration URL"), "https://mcp.example.com/");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
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
  await userEvent.click(screen.getByText("Advanced settings"));
  expect(screen.getByRole("checkbox", { name: "Allow shared accounts" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
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
test("preset forms offer only the provider's supported authentication methods", async () => {
  render(
    <McpServerForm
      onSaved={vi.fn()}
      suggestion={{
        id: "slack-mcp",
        label: "Slack",
        authentication: "oauth",
        authenticationMethods: ["oauth"],
        transport: { type: "streamable-http", url: "https://mcp.slack.com/mcp" },
      }}
    />
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Sign-in method" }));
  expect(screen.getByRole("option", { name: "Sign in with provider" })).toBeVisible();
  expect(screen.queryByRole("option", { name: "Access token" })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "No sign-in" })).not.toBeInTheDocument();
});

test("custom integrations retain the no-sign-in option", async () => {
  render(<McpServerForm onSaved={vi.fn()} />);
  await userEvent.click(screen.getByRole("combobox", { name: "Sign-in method" }));
  expect(screen.getByRole("option", { name: "No sign-in" })).toBeVisible();
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
  await userEvent.click(screen.getByText("Advanced settings"));
  expect(
    screen.getByText(/Production requires operator-configured Kata VM isolation/)
  ).toBeInTheDocument();
  await userEvent.type(
    screen.getByLabelText("Required secret names"),
    "GITHUB_PERSONAL_ACCESS_TOKEN"
  );
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
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
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
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
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("reserved for channel setup");
    expect(screen.getByLabelText("Integration ID")).toHaveValue(id);
    expect(screen.getByLabelText("Integration ID")).toBeVisible();
    expect(configureMcpIntegration).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  }
);

test("provider setup hides technical defaults and never enables an integration on creation", async () => {
  render(
    <McpServerForm
      onSaved={vi.fn()}
      suggestion={{
        id: "github-mcp",
        label: "GitHub",
        transport: { type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" },
        authentication: "token",
      }}
    />
  );
  expect(screen.getByLabelText("Name")).not.toBeVisible();
  expect(screen.getByRole("combobox", { name: "Sign-in method" })).toBeVisible();
  expect(screen.getByLabelText("Integration URL")).not.toBeVisible();
  expect(screen.getByLabelText("Integration ID")).not.toBeVisible();
  expect(screen.queryByLabelText("Integration enabled")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(configureMcpIntegration).toHaveBeenCalledWith(
    "github-mcp",
    expect.objectContaining({ enabled: false })
  );
});

test("chooses an unused ID from the name without overwriting an existing integration", async () => {
  render(<McpServerForm onSaved={vi.fn()} existingIds={["support", "support-2"]} />);
  await userEvent.type(screen.getByLabelText("Name"), "Support");
  await userEvent.type(screen.getByLabelText("Integration URL"), "https://mcp.example.com/");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(configureMcpIntegration).toHaveBeenCalledWith(
    "support-3",
    expect.objectContaining({ enabled: false })
  );
});

test("custom IDs remain editable under Advanced settings and invalid IDs are not sent", async () => {
  render(<McpServerForm onSaved={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("Name"), "Support");
  await userEvent.type(screen.getByLabelText("Integration URL"), "https://mcp.example.com/");
  await userEvent.click(screen.getByText("Advanced settings"));
  await userEvent.clear(screen.getByLabelText("Integration ID"));
  await userEvent.type(screen.getByLabelText("Integration ID"), "Not a valid ID");
  await userEvent.click(screen.getByText("Advanced settings"));
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("lowercase letters");
  expect(screen.getByLabelText("Integration ID")).toBeVisible();
  expect(configureMcpIntegration).not.toHaveBeenCalled();
});
