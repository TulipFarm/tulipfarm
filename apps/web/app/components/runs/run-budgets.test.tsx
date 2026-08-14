import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunBudgets } from "./run-budgets";

describe("RunBudgets", () => {
  it("shows a loading state while the ledger is fetched", () => {
    render(<RunBudgets state={{ status: "loading" }} />);
    expect(screen.getByText(/loading budgets/i)).toBeInTheDocument();
  });

  it("reports a fetch failure honestly instead of an empty ledger", () => {
    render(<RunBudgets state={{ status: "error", message: "network down" }} />);
    expect(screen.getByText(/couldn't load budgets: network down/i)).toBeInTheDocument();
  });

  it("says a Run with no ceilings is unbounded rather than zero", () => {
    render(<RunBudgets state={{ status: "loaded", budgets: [] }} />);
    expect(screen.getByText(/unbounded/i)).toBeInTheDocument();
    expect(screen.queryByText("0 / 0")).not.toBeInTheDocument();
  });

  it("renders each limit key with its consumption and headroom", () => {
    render(
      <RunBudgets
        state={{
          status: "loaded",
          budgets: [
            {
              key: "usd_micros",
              limit: 1_000_000,
              consumed: 250_000,
              exhaustionPolicy: "failure_path",
            },
          ],
        }}
      />
    );
    expect(screen.getByText("usd_micros")).toBeInTheDocument();
    expect(screen.getByText("250,000 / 1,000,000")).toBeInTheDocument();
    expect(screen.getByText("750,000 left")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  });

  it("makes an exhausted budget visually obvious", () => {
    render(
      <RunBudgets
        state={{
          status: "loaded",
          budgets: [
            { key: "tokens", limit: 1000, consumed: 1000, exhaustionPolicy: "attention_required" },
          ],
        }}
      />
    );
    expect(screen.getByText("Exhausted")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });
});
