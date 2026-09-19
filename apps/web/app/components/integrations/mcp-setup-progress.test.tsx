import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import type { McpSetupStatus } from "@tulipfarm/schema";
import { expect, test, vi } from "vitest";
import { McpSetupProgress } from "./mcp-setup-progress";
import type { useMcpSetup } from "./use-mcp-setup";

let admin = false;
vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => admin }));

test.each([true, false])(
  "publication failure explains repair and offers an explicit saved retry (admin=%s)",
  (isAdmin) => {
    admin = isAdmin;
    const resume = vi.fn();
    const operation = {
      id: "saved-setup",
      integrationKey: "github-mcp",
      status: "retry",
      error: "publication_failed",
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
                resume,
              } as unknown as ReturnType<typeof useMcpSetup>
            }
          />
        ),
      },
    ]);
    render(<Stub />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "TulipFarm could not activate the integration settings"
    );
    expect(
      screen.getByText(/This does not mean your provider credentials are wrong/)
    ).toBeVisible();
    if (isAdmin) {
      expect(screen.getByRole("link", { name: "Open Operations" })).toHaveAttribute(
        "href",
        "/operations"
      );
      expect(screen.getByRole("link", { name: "Open Activity" })).toHaveAttribute(
        "href",
        "/business/activities"
      );
    } else {
      expect(screen.getByText(/Ask an admin to check Operations and Activity/)).toBeVisible();
      expect(screen.queryByRole("link", { name: "Open Operations" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Open Activity" })).not.toBeInTheDocument();
    }
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(resume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved setup" }));
    expect(resume).toHaveBeenCalledExactlyOnceWith();
  }
);

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
