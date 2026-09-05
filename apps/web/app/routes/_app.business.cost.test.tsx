import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ObsSummary } from "~/lib/observability";
import SettingsCost from "./_app.business.cost";

function summary(overrides: Partial<ObsSummary> = {}): ObsSummary {
  return {
    totals: { cost: 1.23, tokens: 100, turns: 5, unpricedCalls: 0 },
    series: [],
    byAgent: [{ agentId: "support-agent", cost: 1 }],
    byMember: [
      { memberId: "user-1", member: "muskan@example.com", cost: 0.8 },
      { memberId: "system", member: "System", cost: 0.43 },
    ],
    byModel: [{ model: "claude-opus-4-8", cost: 1.23, calls: 5, unpriced: false }],
    modelSeries: [],
    reliability: {
      turns: 5,
      turnErrors: 0,
      llmCalls: 5,
      llmErrors: 0,
      fallbacks: 0,
      toolCalls: 0,
      toolErrors: 0,
      p95DurationMs: 0,
    },
    ...overrides,
  };
}

function renderRoute(initial: ObsSummary) {
  const Stub = createRemixStub([
    {
      path: "/business/cost",
      Component: SettingsCost,
      loader: () => ({ initial, businessCurrency: "USD", businessCurrencyRate: 1 }),
    },
  ]);
  return render(<Stub initialEntries={["/business/cost"]} />);
}

describe("Cost page tabs", () => {
  it("shows Summary content by default and switches to By Members on click", async () => {
    const user = userEvent.setup();
    renderRoute(summary());
    expect(await screen.findByText("Spend over time")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "By Members" }));
    expect(await screen.findByText("muskan@example.com")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.queryByText("Spend over time")).toBeNull();
  });

  it("keeps the disabled Team tab unreachable by click or arrow-key cycling", async () => {
    const user = userEvent.setup();
    renderRoute(summary());
    const team = await screen.findByRole("tab", { name: /Team/ });
    expect(team).toBeDisabled();

    await user.click(team);
    expect(team).toHaveAttribute("aria-selected", "false");

    const summaryTab = screen.getByRole("tab", { name: "Summary" });
    summaryTab.focus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "By Members" })).toHaveFocus();
  });
});
