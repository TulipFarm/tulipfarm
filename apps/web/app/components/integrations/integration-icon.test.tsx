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

  test("wears the brand's colour, corrected for each canvas", () => {
    const { container } = render(
      <IntegrationIcon label="GitHub" iconPath="M0 0h24v24H0z" iconColor="181717" />
    );
    const tile = container.firstElementChild as HTMLElement;
    // Both corrections are published so the `dark:` variant can switch between them without
    // JavaScript — GitHub's near-black is unreadable on the dark canvas as authored.
    expect(tile.style.getPropertyValue("--brand-light")).toBe("oklch(0.206 0.0016 17.3)");
    expect(tile.style.getPropertyValue("--brand-dark")).toBe("oklch(0.720 0.0016 17.3)");
  });

  test("colours the monogram too, so a brand without a mark is still that brand", () => {
    // The whole reason the registry carries a colour: one grey tile among coloured logos reads as
    // a failed image rather than as a brand that has no logo to show.
    const { container } = render(<IntegrationIcon label="Slack" iconColor="4A154B" />);
    const tile = container.firstElementChild as HTMLElement;
    expect(screen.getByText("SL")).toBeInTheDocument();
    expect(tile.style.getPropertyValue("--brand-light")).toContain("oklch(");
    expect(tile.className).toContain("text-[var(--brand)]");
  });

  test("falls back to the muted treatment when no colour is curated", () => {
    // An integration installed from a URL has no registry entry, so inventing a colour for it
    // would be inventing a brand.
    const { container } = render(<IntegrationIcon label="Acme CRM" />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.style.getPropertyValue("--brand-light")).toBe("");
    expect(tile.className).toContain("text-muted-foreground");
  });
});
