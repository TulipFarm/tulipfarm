import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import type { McpSetupStatus } from "@tulipfarm/schema";
import { expect, test, vi } from "vitest";
import { McpSetupProgress } from "./mcp-setup-progress";
import type { useMcpSetup } from "./use-mcp-setup";

test.each(["preserved_empty", "discovered_empty"] as const)(
  "completed %s setup does not direct the user to an unusable Chat",
  async (state) => {
    const operation = {
      id: "done",
      integrationKey: "github-mcp",
      accountId: "same-account",
      status: "done",
      access: { state, enabled: true, tools: 0, resources: 0, prompts: 0 },
    } as McpSetupStatus;
    const Stub = createRemixStub([
      {
        path: "/",
        Component: () => (
          <McpSetupProgress
            setup={
              {
                operation,
                pending: false,
                uncertain: false,
                error: undefined,
                refresh: vi.fn(),
                resume: vi.fn(),
              } as unknown as ReturnType<typeof useMcpSetup>
            }
          />
        ),
      },
    ]);
    render(<Stub />);
    expect(screen.queryByRole("link", { name: "Open Chat" })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        state === "discovered_empty"
          ? /The provider returned no Tools or content/
          : /Existing settings allow no Tools or content/
      )
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Review integration access" })).toHaveAttribute(
      "href",
      "/integrations/github-mcp"
    );
  }
);
