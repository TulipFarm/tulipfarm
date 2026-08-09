import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { IntegrationIcon, monogram } from "./integration-icon";

describe("monogram", () => {
  test("takes an initial from each of the first two words", () => {
    expect(monogram("Google Drive")).toBe("GD");
    expect(monogram("Microsoft Teams")).toBe("MT");
  });

  test("takes two letters from a single-word name", () => {
    // One letter collides constantly across a catalog this shape — "S" would be Slack, Stripe,
    // Salesforce, and Sentry at once.
    expect(monogram("slack")).toBe("SL");
    expect(monogram("Notion")).toBe("NO");
  });

  test("splits a slug on its separators", () => {
    expect(monogram("google-workspace")).toBe("GW");
    expect(monogram("acme_crm")).toBe("AC");
  });

  test("survives a name it cannot read", () => {
    expect(monogram("")).toBe("?");
    expect(monogram("   ")).toBe("?");
  });
});

describe("IntegrationIcon", () => {
  test("renders the brand mark when one was resolved", () => {
    const { container } = render(<IntegrationIcon label="GitHub" iconPath="M0 0h24v24H0z" />);
    expect(container.querySelector("path")).toHaveAttribute("d", "M0 0h24v24H0z");
    expect(screen.queryByText("GI")).not.toBeInTheDocument();
  });

  test("falls back to a monogram when the brand has no mark", () => {
    // Slack asked to be removed from Simple Icons, so this is the everyday path, not an edge case.
    const { container } = render(<IntegrationIcon label="Slack" />);
    expect(container.querySelector("path")).toBeNull();
    expect(screen.getByText("SL")).toBeInTheDocument();
  });

  test("stays out of the accessibility tree, since the name is rendered beside it", () => {
    const { container } = render(<IntegrationIcon label="GitHub" iconPath="M0 0h24v24H0z" />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden");
  });
});
