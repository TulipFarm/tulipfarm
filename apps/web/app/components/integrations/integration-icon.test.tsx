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

  test("wears the brand's colour, corrected for the tile it sits on", () => {
    const { container } = render(
      <IntegrationIcon label="GitHub" iconPath="M0 0h24v24H0z" iconColor="181717" />
    );
    const tile = container.firstElementChild as HTMLElement;
    // One correction, not two: the tile is light in both themes, so the dark-canvas variant of the
    // brand colour would only ever wash the mark out.
    expect(tile.style.getPropertyValue("--integration-ink")).toBe("oklch(0.206 0.0016 17.3)");
    expect(container.querySelector("svg")?.getAttribute("class")).toContain(
      "text-[var(--integration-ink)]"
    );
  });

  test("leaves a monogram neutral, because a two-letter word is not a logo", () => {
    // A coloured monogram claims to be a brand mark. It is a placeholder, and reading as one is
    // the honest outcome — the colour belongs to marks the brand actually authored.
    const { container } = render(<IntegrationIcon label="Slack" iconColor="4A154B" />);
    expect(screen.getByText("SL")).toBeInTheDocument();
    expect(screen.getByText("SL").className).toContain("text-neutral-500");
    expect(container.querySelector("svg")).toBeNull();
  });

  test("needs no colour at all when none is curated", () => {
    // An integration installed from a URL has no registry entry, so inventing a colour for it
    // would be inventing a brand.
    const { container } = render(<IntegrationIcon label="Acme CRM" />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.style.getPropertyValue("--integration-ink")).toBe("");
    expect(screen.getByText("AC")).toBeInTheDocument();
  });

  test("prefers the vendored full-colour mark over the monochrome glyph", () => {
    // Slack is the case this exists for: it is absent from Simple Icons, so without the vendored
    // mark the catalog shows an "SL" monogram where every other tile shows a logo.
    const { container } = render(<IntegrationIcon label="Slack" iconSlug="slack" />);
    const fills = [...container.querySelectorAll("path")].map((p) => p.getAttribute("fill"));
    expect(fills).toEqual(["#E01E5A", "#36C5F0", "#2EB67D", "#ECB22E"]);
    expect(screen.queryByText("SL")).not.toBeInTheDocument();
  });

  test("keeps the tile neutral behind a full-colour mark", () => {
    // Tinting the tile with one of the brand's four colours would fight the other three, and
    // tinting only *some* tiles is what makes a grid read as several card designs rather than one.
    // So every tier gets the same tile, whatever mark ends up on it.
    const tiles = [
      render(<IntegrationIcon label="Slack" iconSlug="slack" iconColor="4A154B" />),
      render(<IntegrationIcon label="GitHub" iconPath="M12 0z" iconColor="181717" />),
      render(<IntegrationIcon label="Acme CRM" />),
    ].map((r) => (r.container.firstElementChild as HTMLElement).className);
    for (const tile of tiles) {
      expect(tile).toContain("bg-white");
      expect(tile).not.toContain("--integration-ink)_12%");
    }
  });

  test("still uses the monochrome glyph for a brand with no vendored mark", () => {
    // GitHub's own logo is monochrome, so the Simple Icons path is the real mark, not a fallback.
    const { container } = render(
      <IntegrationIcon label="GitHub" iconSlug="github" iconPath="M12 0z" iconColor="181717" />
    );
    expect(container.querySelector("path")?.getAttribute("d")).toBe("M12 0z");
    expect(container.querySelector("svg")?.getAttribute("class")).toContain(
      "text-[var(--integration-ink)]"
    );
  });
});
