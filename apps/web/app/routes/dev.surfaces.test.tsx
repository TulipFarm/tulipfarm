import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as clipboard from "~/lib/clipboard";
import DevelopmentSurfacesRoute from "./dev.surfaces";

describe("/dev/surfaces - Tulip Surface Protocol Sandbox", () => {
  it("S1: loads sandbox layout, heading, and default preset", () => {
    render(<DevelopmentSurfacesRoute />);
    expect(
      screen.getByRole("heading", { name: "Tulip Surface Protocol Sandbox" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Template preset selector")).toBeInTheDocument();
    expect(screen.getByText("Customer Profile Card")).toBeInTheDocument();
  });

  it("S1: switches between standard presets (Form Card, Status Widget, Table Artifact, Interactive Form, Error Banner)", async () => {
    render(<DevelopmentSurfacesRoute />);
    const selector = screen.getByLabelText("Template preset selector");

    const preview = () => screen.getByTestId("react-renderer-preview");

    // Select Status Widget
    fireEvent.change(selector, { target: { value: "status-widget" } });
    expect(within(preview()).getByText("Operational · All systems healthy")).toBeInTheDocument();

    // Select Table Artifact
    fireEvent.change(selector, { target: { value: "table-artifact" } });
    expect(within(preview()).getByText("API Gateway")).toBeInTheDocument();
    expect(within(preview()).getByText("Worker Engine")).toBeInTheDocument();

    // Select Interactive Form
    fireEvent.change(selector, { target: { value: "interactive-form" } });
    expect(within(preview()).getByText("Create Infrastructure Ticket")).toBeInTheDocument();
    expect(within(preview()).getByRole("button", { name: "Submit Form" })).toBeInTheDocument();

    // Select Error Banner
    fireEvent.change(selector, { target: { value: "error-banner" } });
    expect(within(preview()).getByText("Deployment Warning")).toBeInTheDocument();

    // Select Choices & Actions
    fireEvent.change(selector, { target: { value: "choices-actions" } });
    expect(within(preview()).getByText(/Choose a deployment strategy/i)).toBeInTheDocument();

    // Select Metric & KPIs
    fireEvent.change(selector, { target: { value: "metrics-kpis" } });
    expect(within(preview()).getByText("Monthly Recurring Revenue")).toBeInTheDocument();

    // Select Timeline Sequence
    fireEvent.change(selector, { target: { value: "timeline" } });
    expect(within(preview()).getByText("Deployment Triggered")).toBeInTheDocument();
  });

  it("S2: switches between multi-renderer tabs (React, Slack, Telegram, GitHub) cleanly", async () => {
    const user = userEvent.setup();
    render(<DevelopmentSurfacesRoute />);

    // Select Interactive Form for rich rendering
    fireEvent.change(screen.getByLabelText("Template preset selector"), {
      target: { value: "interactive-form" },
    });

    // Default is React (Web)
    expect(screen.getByTestId("react-renderer-preview")).toBeInTheDocument();

    // Switch to Slack (Block Kit)
    const slackTab = screen.getByRole("tab", { name: /Slack/i });
    await user.click(slackTab);
    const slackPreview = screen.getByTestId("slack-renderer-preview");
    expect(slackPreview).toBeInTheDocument();
    expect(within(slackPreview).getByText(/Slack Block Kit/i)).toBeInTheDocument();

    // Switch to Telegram
    const telegramTab = screen.getByRole("tab", { name: /Telegram/i });
    await user.click(telegramTab);
    const telegramPreview = screen.getByTestId("telegram-renderer-preview");
    expect(telegramPreview).toBeInTheDocument();
    expect(within(telegramPreview).getByText(/Telegram Bot API/i)).toBeInTheDocument();

    // Switch to GitHub
    const githubTab = screen.getByRole("tab", { name: /GitHub/i });
    await user.click(githubTab);
    const githubPreview = screen.getByTestId("github-renderer-preview");
    expect(githubPreview).toBeInTheDocument();
    expect(within(githubPreview).getByText(/GitHub Renderer/i)).toBeInTheDocument();

    // Switch back to React
    const reactTab = screen.getByRole("tab", { name: /React/i });
    await user.click(reactTab);
    expect(screen.getByTestId("react-renderer-preview")).toBeInTheDocument();
  });

  it("S2 & S3: captures interaction events across different platform renderers", async () => {
    const user = userEvent.setup();
    render(<DevelopmentSurfacesRoute />);

    // 1. React Web Interaction
    fireEvent.change(screen.getByLabelText("Template preset selector"), {
      target: { value: "interactive-form" },
    });
    await user.type(screen.getByLabelText(/Ticket Title/i), "Database issue");
    await user.selectOptions(screen.getByLabelText(/Environment/i), "production");
    await user.type(screen.getByLabelText(/Contact Email/i), "admin@tulipfarm.dev");
    await user.click(screen.getByRole("button", { name: "Submit Form" }));

    expect(screen.getByText("1 event logged")).toBeInTheDocument();
    expect(screen.getByText("ticket.create")).toBeInTheDocument();

    // 2. Telegram Inline Keyboard Interaction
    fireEvent.change(screen.getByLabelText("Template preset selector"), {
      target: { value: "choices-actions" },
    });
    await user.click(screen.getByRole("tab", { name: /Telegram/i }));
    const tgButton = screen.getByRole("button", { name: /Canary Rollout/i });
    await user.click(tgButton);

    expect(screen.getByText("2 events logged")).toBeInTheDocument();

    // 3. GitHub Check Run Action Interaction
    await user.click(screen.getByRole("tab", { name: /GitHub/i }));
    await user.click(screen.getByRole("button", { name: /Check Run Card/i }));
    const githubPreview = screen.getByTestId("github-renderer-preview");
    expect(
      within(githubPreview).getByRole("button", { name: /Check Run Card/i })
    ).toBeInTheDocument();

    // Clear events
    await user.click(screen.getByRole("button", { name: /Clear Log/i }));
    expect(screen.getByText("0 events logged")).toBeInTheDocument();
  });

  it("S4: handles invalid component injection, syntax errors, and malformed JSON resilience", async () => {
    const user = userEvent.setup();
    render(<DevelopmentSurfacesRoute />);

    // Inject invalid component type
    const injectBtn = screen.getByRole("button", { name: "Inject Invalid Component" });
    await user.click(injectBtn);

    // Shows schema validation issues banner & fallback error state
    expect(screen.getAllByRole("alert").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("schema-error-state")).toBeInTheDocument();
    expect(
      screen.getByText(/Schema Error Fallback: Invalid Surface Artifact/i)
    ).toBeInTheDocument();

    // Clear payload to test empty/malformed JSON resilience
    const clearPayloadBtn = screen.getByRole("button", { name: /Clear Payload/i });
    await user.click(clearPayloadBtn);
    expect(screen.getByTestId("schema-error-state")).toBeInTheDocument();

    // Test syntax error by typing invalid json
    const textarea = screen.getByLabelText("Raw JSON payload editor");
    fireEvent.change(textarea, { target: { value: "{\n  invalid: true" } });
    expect(screen.getByTestId("schema-error-state")).toBeInTheDocument();
    expect(screen.getByText(/Malformed JSON Syntax/i)).toBeInTheDocument();

    // Restore valid preset
    const restoreBtn = screen.getByRole("button", { name: "Restore Valid Preset" });
    await user.click(restoreBtn);

    // Recovers cleanly
    expect(screen.queryByTestId("schema-error-state")).not.toBeInTheDocument();
    expect(screen.getByText("Customer Profile Card")).toBeInTheDocument();
  });

  it("S4: formats and copies JSON payload in the editor", async () => {
    const user = userEvent.setup();
    render(<DevelopmentSurfacesRoute />);

    // Test Format button
    const formatBtn = screen.getByRole("button", { name: /Format/i });
    await user.click(formatBtn);

    // Test Copy button
    const copySpy = vi.spyOn(clipboard, "copyText").mockResolvedValue(true);
    const copyBtn = screen.getByTitle("Copy JSON");
    await user.click(copyBtn);
    expect(copySpy).toHaveBeenCalled();
  });

  it("S5: switches viewport simulation modes (Desktop, Tablet, Mobile)", async () => {
    const user = userEvent.setup();
    render(<DevelopmentSurfacesRoute />);

    const mobileBtn = screen.getByRole("button", { name: /Mobile/i });
    await user.click(mobileBtn);
    expect(mobileBtn).toHaveClass("bg-background");

    const tabletBtn = screen.getByRole("button", { name: /Tablet/i });
    await user.click(tabletBtn);
    expect(tabletBtn).toHaveClass("bg-background");

    const desktopBtn = screen.getByRole("button", { name: /Desktop/i });
    await user.click(desktopBtn);
    expect(desktopBtn).toHaveClass("bg-background");
  });
});
