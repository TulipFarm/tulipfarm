import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getLlmConfig, listProviders, listSecrets } from "~/lib/settings";
import BusinessModels, { clientLoader } from "./_app.business.models";

vi.mock("~/lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/settings")>()),
  getLlmConfig: vi.fn(),
  listProviders: vi.fn(),
  listSecrets: vi.fn(),
  putLlmConfig: vi.fn(),
}));

/**
 * Raw palette utilities and literal colours are theme-blind: they paint the same value under
 * `[data-theme="light"]` and `[data-theme="dark"]`, which is how a page ends up stuck in one
 * theme (#420). Only the `@theme inline` semantic tokens in `app/app.css` follow the attribute.
 */
const THEME_BLIND_UTILITY =
  /^(?:bg|text|border|from|via|to|ring|outline|fill|stroke|decoration|caret|accent|divide|placeholder)-(?:\[[^\]]*(?:#|rgb|hsl|oklch)[^\]]*\]|black(?:\/\d+)?$|white(?:\/\d+)?$|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})/;

const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i;

function themeBlindStyling(root: HTMLElement): string[] {
  const found: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    for (const token of el.className.toString().split(/\s+/).filter(Boolean)) {
      const utility = token.slice(token.lastIndexOf(":") + 1);
      if (THEME_BLIND_UTILITY.test(utility)) found.push(token);
    }
    const inline = el.getAttribute("style");
    if (inline && LITERAL_COLOUR.test(inline)) found.push(`style="${inline}"`);
  }
  return found;
}

function classTokens(root: HTMLElement): Set<string> {
  const tokens = new Set<string>();
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    for (const token of el.className.toString().split(/\s+/).filter(Boolean)) tokens.add(token);
  }
  return tokens;
}

beforeEach(() => {
  document.documentElement.setAttribute("data-theme", "light");
  vi.mocked(getLlmConfig).mockResolvedValue({
    tiers: {
      quick: { providers: [{ provider: "openai", model: "gpt-5-mini" }] },
      standard: { providers: [{ provider: "openai", model: "gpt-5" }] },
      complex: { providers: [{ provider: "anthropic", model: "claude-opus-4" }] },
    },
    presets: { default: "balanced", fast: "fast", balanced: "balanced", thorough: "thorough" },
  });
  vi.mocked(listSecrets).mockResolvedValue([
    { key: "OPENAI_API_KEY", type: "user-provided", createdAt: "", updatedAt: "" },
  ]);
  vi.mocked(listProviders).mockResolvedValue([
    {
      id: "openai",
      label: "OpenAI",
      fields: [{ key: "OPENAI_API_KEY", label: "API key", role: "api_key", kind: "secret" }],
    },
    {
      id: "anthropic",
      label: "Anthropic",
      fields: [{ key: "ANTHROPIC_API_KEY", label: "API key", role: "api_key", kind: "secret" }],
    },
  ]);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

function renderPage() {
  const Stub = createRemixStub([
    { path: "/business/models", Component: BusinessModels, loader: clientLoader },
  ]);
  return render(<Stub initialEntries={["/business/models"]} />);
}

test("dresses every surface in theme-aware tokens under the light theme", async () => {
  const { container } = renderPage();
  expect(await screen.findByText("gpt-5")).toBeInTheDocument();

  expect(themeBlindStyling(container)).toEqual([]);

  // Absence alone would also pass on an unstyled page, so pin the surfaces that carry the theme:
  // the Panel's card background and the form controls' page background.
  const tokens = classTokens(container);
  expect(tokens).toContain("bg-card");
  expect(tokens).toContain("bg-background");
});
