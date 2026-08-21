import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ModelChains } from "~/components/model-chains";
import {
  getModelOptions,
  type LlmConfig,
  type LlmProviderInfo,
  resolveModelSpec,
} from "~/lib/settings";

vi.mock("~/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/settings")>();
  return {
    ...actual,
    getModelOptions: vi.fn().mockResolvedValue({ models: [], source: "unavailable" }),
    resolveModelSpec: vi.fn().mockResolvedValue({ spec: null, matchedKey: null, candidates: [] }),
  };
});

vi.mock("@remix-run/react", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const PROVIDERS: LlmProviderInfo[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    fields: [{ key: "anthropic-api-key", label: "API key", role: "api_key", kind: "secret" }],
  },
  {
    id: "openai",
    label: "OpenAI",
    fields: [{ key: "openai-api-key", label: "API key", role: "api_key", kind: "secret" }],
  },
];

const ALL_SECRETS = ["anthropic-api-key", "openai-api-key"];

const initial: LlmConfig = {
  presets: { default: "balanced" },
  tiers: {
    quick: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
    standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
    complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
  },
  embeddings: { providers: [{ provider: "openai", model: "text-embedding-3-small" }] },
};

function renderChains(overrides: Partial<Parameters<typeof ModelChains>[0]> = {}) {
  const onSubmit = vi.fn();
  render(
    <ModelChains
      initial={initial}
      providers={PROVIDERS}
      secretKeys={ALL_SECRETS}
      onSubmit={onSubmit}
      submitting={false}
      formError={null}
      {...overrides}
    />
  );
  return onSubmit;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(getModelOptions).mockResolvedValue({ models: [], source: "unavailable" });
  vi.mocked(resolveModelSpec).mockResolvedValue({ spec: null, matchedKey: null, candidates: [] });
});

test("names tiers by effort preset and never by the retired wire names", () => {
  renderChains();

  expect(screen.getByRole("heading", { name: "Fast" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Balanced" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Thorough" })).toBeInTheDocument();
  for (const retired of ["quick", "standard", "complex"]) {
    expect(screen.queryByText(new RegExp(`\\b${retired}\\b`, "i"))).not.toBeInTheDocument();
  }
});

test("renders each chain in fallback order and marks the first entry primary", () => {
  renderChains({
    initial: {
      ...initial,
      tiers: {
        quick: {
          providers: [
            { provider: "anthropic", model: "claude-haiku-4-5" },
            { provider: "openai", model: "gpt-4o-mini" },
          ],
        },
        standard: initial.tiers?.standard ?? { providers: [] },
        complex: initial.tiers?.complex ?? { providers: [] },
      },
    },
  });

  const fast = screen.getByRole("heading", { name: "Fast" }).closest("section");
  const entries = within(fast as HTMLElement).getAllByRole("listitem");
  expect(entries).toHaveLength(2);
  expect(entries[0]).toHaveTextContent("claude-haiku-4-5");
  expect(entries[0]).toHaveTextContent("Primary");
  expect(entries[1]).toHaveTextContent("gpt-4o-mini");
  expect(entries[1]).not.toHaveTextContent("Primary");
});

test("preserves the retired wire tier names when serializing", async () => {
  const onSubmit = renderChains();

  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(Object.keys(submitted.tiers ?? {})).toEqual(["quick", "standard", "complex"]);
  expect(submitted.tiers?.quick.providers[0]?.model).toBe("claude-haiku-4-5");
  // Untouched sections survive a full-replace PUT.
  expect(submitted.embeddings).toEqual(initial.embeddings);
});

test("reordering a chain changes which model is tried first", async () => {
  const onSubmit = renderChains({
    initial: {
      ...initial,
      tiers: {
        quick: {
          providers: [
            { provider: "anthropic", model: "claude-haiku-4-5" },
            { provider: "openai", model: "gpt-4o-mini" },
          ],
        },
        standard: initial.tiers?.standard ?? { providers: [] },
        complex: initial.tiers?.complex ?? { providers: [] },
      },
    },
  });

  await userEvent.click(screen.getByRole("button", { name: /move gpt-4o-mini earlier/i }));
  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.tiers?.quick.providers.map((p) => p.model)).toEqual([
    "gpt-4o-mini",
    "claude-haiku-4-5",
  ]);
});

test("blocks saving a chain whose provider has no stored credential", async () => {
  const onSubmit = renderChains({ secretKeys: ["openai-api-key"] });

  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

  expect(onSubmit).not.toHaveBeenCalled();
  expect(await screen.findByRole("alert")).toHaveTextContent(/no stored credential/i);
});

test("points at Secrets when nothing is configured at all", () => {
  renderChains({ secretKeys: [] });

  expect(screen.getByText(/no provider is configured yet/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /add provider credentials/i })).toHaveAttribute(
    "href",
    "/business/secrets"
  );
});

test("editing a chain entry opens the drawer and writes the chosen model back", async () => {
  vi.mocked(getModelOptions).mockResolvedValue({
    models: ["claude-haiku-4-5", "claude-sonnet-4-6"],
    source: "catalog",
  });
  const onSubmit = renderChains();

  await userEvent.click(screen.getByRole("button", { name: "Edit claude-haiku-4-5" }));
  // The target id is one of the catalogue suggestions, so it is chosen from the dropdown rather
  // than typed. Free-text entry is the "Custom…" branch, covered by the tests below.
  await userEvent.selectOptions(await screen.findByLabelText("Model ID"), "claude-sonnet-4-6");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.tiers?.quick.providers[0]?.model).toBe("claude-sonnet-4-6");
});

test("lets an operator pin one catalogue candidate for an ambiguous model", async () => {
  vi.mocked(resolveModelSpec)
    .mockResolvedValueOnce({
      spec: null,
      matchedKey: null,
      candidates: ["azure_ai/kimi-k2.5", "openrouter/moonshotai/kimi-k2.5"],
    })
    .mockResolvedValueOnce({
      spec: { litellm_key: "azure_ai/kimi-k2.5", max_input_tokens: 256000 },
      matchedKey: "azure_ai/kimi-k2.5",
      candidates: [],
    });
  const onSubmit = renderChains();

  await userEvent.click(screen.getByRole("button", { name: "Edit claude-haiku-4-5" }));
  const model = await screen.findByLabelText("Model ID");
  await userEvent.clear(model);
  await userEvent.type(model, "kimi-k2.5");
  await userEvent.tab();

  await userEvent.click(await screen.findByRole("button", { name: "azure_ai/kimi-k2.5" }));
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.tiers?.quick.providers[0]?.spec).toMatchObject({
    litellm_key: "azure_ai/kimi-k2.5",
    max_input_tokens: 256000,
  });
});

test("accepts a manual context window when the catalogue has no match", async () => {
  const onSubmit = renderChains();

  await userEvent.click(screen.getByRole("button", { name: "Edit claude-haiku-4-5" }));
  const model = await screen.findByLabelText("Model ID");
  await userEvent.clear(model);
  await userEvent.type(model, "private-model");
  await userEvent.tab();

  const context = await screen.findByLabelText("Context window");
  await userEvent.type(context, "131072");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.tiers?.quick.providers[0]?.spec).toEqual({ max_input_tokens: 131072 });
});

test("adding a fallback creates a numbered profile the presets can target", async () => {
  const onSubmit = renderChains();

  const fast = screen.getByRole("heading", { name: "Fast" }).closest("section");
  await userEvent.click(within(fast as HTMLElement).getByRole("button", { name: /add fallback/i }));

  await userEvent.selectOptions(await screen.findByLabelText("Provider"), "openai");
  const model = await screen.findByLabelText("Model ID");
  await userEvent.type(model, "gpt-4o-mini");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));

  // The new entry names a profile, which the preset selects can then target.
  await waitFor(() => {
    expect(screen.getAllByText(/fast-fallback-1/).length).toBeGreaterThan(0);
  });
  expect(
    within(screen.getByLabelText("Fast")).getByRole("option", { name: /fast-fallback-1/ })
  ).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.tiers?.quick.providers).toHaveLength(2);
  expect(submitted.tiers?.quick.providers[1]).toMatchObject({
    provider: "openai",
    model: "gpt-4o-mini",
  });
});

test("an empty fallback Model ID stays in the sheet and is not offered to presets", async () => {
  renderChains();

  const fast = screen.getByRole("heading", { name: "Fast" }).closest("section");
  await userEvent.click(within(fast as HTMLElement).getByRole("button", { name: /add fallback/i }));
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));

  expect(screen.getByText("Enter a Model ID.")).toBeInTheDocument();
  expect(screen.getByLabelText("Model ID")).toBeInTheDocument();
  expect(
    within(screen.getByLabelText("Fast")).queryByRole("option", { name: /fast-fallback-1/ })
  ).not.toBeInTheDocument();

  await userEvent.type(screen.getByLabelText("Model ID"), "gpt-4o-mini");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));

  expect(
    within(screen.getByLabelText("Fast")).getByRole("option", { name: /fast-fallback-1/ })
  ).toBeInTheDocument();
});

test("an incomplete fallback never enters the chain, even before Done is pressed", async () => {
  const onSubmit = renderChains();

  const fast = screen.getByRole("heading", { name: "Fast" }).closest("section");
  await userEvent.click(within(fast as HTMLElement).getByRole("button", { name: /add fallback/i }));

  // The chain behind the sheet still holds only the primary; nothing renders as "no model set".
  expect(within(fast as HTMLElement).getAllByRole("listitem")).toHaveLength(1);
  expect(within(fast as HTMLElement).queryByText(/no model set/i)).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /^close$/i }));

  expect(within(fast as HTMLElement).getAllByRole("listitem")).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.tiers?.quick.providers).toHaveLength(1);
});

test("a fallback with no provider selected stays in the sheet with a field error", async () => {
  renderChains();

  const fast = screen.getByRole("heading", { name: "Fast" }).closest("section");
  await userEvent.click(within(fast as HTMLElement).getByRole("button", { name: /add fallback/i }));
  await userEvent.selectOptions(await screen.findByLabelText("Provider"), "");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));

  expect(screen.getByText("Select a provider.")).toBeInTheDocument();
  expect(within(fast as HTMLElement).getAllByRole("listitem")).toHaveLength(1);
});

test("a whitespace-only fallback Model ID is refused like an empty one", async () => {
  const onSubmit = renderChains();

  const fast = screen.getByRole("heading", { name: "Fast" }).closest("section");
  await userEvent.click(within(fast as HTMLElement).getByRole("button", { name: /add fallback/i }));
  await userEvent.type(await screen.findByLabelText("Model ID"), "   ");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));

  expect(screen.getByText("Enter a Model ID.")).toBeInTheDocument();
  expect(within(fast as HTMLElement).getAllByRole("listitem")).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: /^close$/i }));
  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
  expect((onSubmit.mock.calls[0][0] as LlmConfig).tiers?.quick.providers).toHaveLength(1);
});

test("abandoning an edit that emptied the Model ID leaves the chain entry intact", async () => {
  const onSubmit = renderChains();

  await userEvent.click(screen.getByRole("button", { name: "Edit claude-haiku-4-5" }));
  await userEvent.clear(await screen.findByLabelText("Model ID"));
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
  expect(screen.getByText("Enter a Model ID.")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /^close$/i }));

  const fast = screen.getByRole("heading", { name: "Fast" }).closest("section");
  expect(within(fast as HTMLElement).queryByText(/no model set/i)).not.toBeInTheDocument();
  expect(within(fast as HTMLElement).getAllByRole("listitem")[0]).toHaveTextContent(
    "claude-haiku-4-5"
  );

  // Re-opening the row must not carry the refusal that the discarded edit raised.
  await userEvent.click(screen.getByRole("button", { name: "Edit claude-haiku-4-5" }));
  expect(await screen.findByLabelText("Model ID")).toHaveValue("claude-haiku-4-5");
  expect(screen.queryByText("Enter a Model ID.")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^close$/i }));

  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
  expect((onSubmit.mock.calls[0][0] as LlmConfig).tiers?.quick.providers[0]?.model).toBe(
    "claude-haiku-4-5"
  );
});

test("a chain already holding a blank entry never offers it as a preset target", async () => {
  renderChains({
    initial: {
      ...initial,
      tiers: {
        quick: {
          providers: [
            { provider: "anthropic", model: "claude-haiku-4-5" },
            { provider: "openai", model: "" },
            { provider: "openai", model: "gpt-4o-mini" },
          ],
        },
        standard: initial.tiers?.standard ?? { providers: [] },
        complex: initial.tiers?.complex ?? { providers: [] },
      },
    },
  });

  const options = within(screen.getByLabelText("Fast"))
    .getAllByRole("option")
    .map((o) => o.textContent ?? "")
    .join("|");
  expect(options).not.toMatch(/unset/);
  expect(options).not.toMatch(/fast-fallback-1\b/);
  // The usable third entry keeps its real position, so a preset targeting it still resolves.
  expect(options).toMatch(/fast-fallback-2/);
});

test("Auto is shown as the profile it resolves to", async () => {
  const onSubmit = renderChains();

  const auto = screen.getByLabelText("Auto resolves to") as HTMLSelectElement;
  expect(auto.value).toBe("balanced");

  await userEvent.selectOptions(auto, "thorough");
  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.presets?.default).toBe("thorough");
});
