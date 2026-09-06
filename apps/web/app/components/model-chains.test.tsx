import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ModelChains } from "~/components/model-chains";
import {
  getModelOptions,
  type LlmConfig,
  type LlmProviderInfo,
  resolveModelSpec,
  testLlmConnection,
} from "~/lib/settings";

vi.mock("~/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/settings")>();
  return {
    ...actual,
    getModelOptions: vi.fn().mockResolvedValue({ models: [], source: "unavailable" }),
    resolveModelSpec: vi.fn().mockResolvedValue({ spec: null, matchedKey: null, candidates: [] }),
    testLlmConnection: vi.fn().mockResolvedValue({ verdict: "reachable" }),
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

// Same model on every tier, so `llmConfigMode` resolves to "basic" and a save from the Basic tab
// commits directly instead of raising the flatten-confirm dialog — used by tests whose intent is
// the embedding row itself, not that confirmation flow (covered separately).
const basicModeInitial: LlmConfig = {
  presets: { default: "balanced" },
  tiers: {
    quick: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
    standard: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
    complex: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
  },
  embeddings: { providers: [{ provider: "openai", model: "text-embedding-3-small" }] },
};

// Tiers differ (haiku/sonnet/opus), so `llmConfigMode` resolves this to "advanced" and every
// render below opens on the Advanced tab by default — see `packages/schema/src/llm.ts`.
const initial: LlmConfig = {
  presets: { default: "balanced" },
  tiers: {
    quick: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
    standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
    complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
  },
  embeddings: { providers: [{ provider: "openai", model: "text-embedding-3-small" }] },
};

function withTiers(quick: LlmConfig["tiers"] extends undefined ? never : { providers: unknown[] }) {
  return {
    ...initial,
    tiers: {
      quick: quick as { providers: { provider: string; model: string }[] },
      standard: initial.tiers?.standard ?? { providers: [] },
      complex: initial.tiers?.complex ?? { providers: [] },
    },
  } as LlmConfig;
}

function renderChains(overrides: Partial<Parameters<typeof ModelChains>[0]> = {}) {
  const onSubmit = vi.fn();
  const { unmount } = render(
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
  return Object.assign(onSubmit, { unmount });
}

async function switchToTab(name: "Basic" | "Advanced") {
  await userEvent.click(screen.getByRole("tab", { name }));
}

/**
 * The whole per-effort card in Advanced (a `<section>`), found by its `<h4>` heading. `EffortCard`
 * gives its `PrimaryRow` a hardcoded `name="Model"` rather than the effort's label, so a button
 * inside can only be told apart by which card it lives in — every query that needs "the Fast
 * button" or "the Fast standby list" goes through this card, never a global name lookup.
 */
function effortRow(label: string): HTMLElement {
  return screen.getByText(label, { selector: "h4" }).closest("section") as HTMLElement;
}

/** The standby chain for one effort lives in the same card as its primary row. */
const standbyList = effortRow;

/** Choose a suggestion from the Model combobox by name, the way a person would. */
async function pickModel(name: string) {
  const input = await screen.findByLabelText("Model");
  await userEvent.clear(input);
  await userEvent.type(input, name);
  await userEvent.click(await screen.findByRole("option", { name }));
}

async function save() {
  const button = screen.getByRole("button", { name: /save changes/i });
  expect(button).toBeEnabled();
  await userEvent.click(button);
}

/** Make one harmless, saveable edit so the save bar is armed. Only exists on the Advanced tab. */
async function touch() {
  await userEvent.click(screen.getByRole("radio", { name: "Make Thorough the default effort" }));
}

/**
 * Assert the page believes it holds nothing unsaved.
 *
 * Stronger than saving and inspecting the payload: it proves an abandoned edit left no trace in
 * any slot, which is the same check the save bar shows the operator.
 */
function expectNoUnsavedChanges() {
  expect(screen.getByText(/everything on this page is saved/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^saved$/i })).toBeDisabled();
}

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(getModelOptions).mockResolvedValue({ models: [], source: "unavailable" });
  vi.mocked(resolveModelSpec).mockResolvedValue({ spec: null, matchedKey: null, candidates: [] });
  vi.mocked(testLlmConnection).mockResolvedValue({ verdict: "reachable" });
});

test("names efforts by preset and never by the retired wire names", () => {
  renderChains();

  for (const label of ["Fast", "Balanced", "Thorough"]) {
    expect(effortRow(label)).toBeInTheDocument();
  }
  for (const retired of ["quick", "standard", "complex"]) {
    expect(screen.queryByText(new RegExp(`\\b${retired}\\b`, "i"))).not.toBeInTheDocument();
  }
});

test("a config with one model per tier and no standbys opens on Basic; one that differs opens on Advanced", () => {
  const basicConfig: LlmConfig = {
    presets: { default: "balanced" },
    tiers: {
      quick: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
      standard: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
      complex: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
    },
    embeddings: { providers: [{ provider: "openai", model: "text-embedding-3-small" }] },
  };
  const onSubmit = renderChains({ initial: basicConfig });
  expect(screen.getByRole("region", { name: "Chat model" })).toBeInTheDocument();
  expect(screen.queryByText("Fast", { selector: "h4" })).not.toBeInTheDocument();
  onSubmit.unmount();

  renderChains();
  expect(screen.getByText("Fast", { selector: "h4" })).toBeInTheDocument();
});

test("shows one model per effort, with the standby chain shown alongside it", () => {
  renderChains({
    initial: withTiers({
      providers: [
        { provider: "anthropic", model: "claude-haiku-4-5" },
        { provider: "openai", model: "gpt-4o-mini" },
      ],
    }),
  });

  const fast = effortRow("Fast");
  expect(fast).toHaveTextContent("claude-haiku-4-5");
  expect(fast).toHaveTextContent("gpt-4o-mini");
  expect(within(fast).getAllByRole("listitem")).toHaveLength(2);
});

test("names the pricing and context facts it puts on screen", () => {
  renderChains({
    initial: withTiers({
      providers: [
        {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          spec: {
            max_input_tokens: 1_000_000,
            input_cost_per_token: 0.00000025,
            output_cost_per_token: 0.000002,
            supports_function_calling: true,
          },
        },
      ],
    }),
  });

  const fast = effortRow("Fast");
  expect(within(fast).getByText("1M tokens")).toBeInTheDocument();
  expect(within(fast).getByText("$0.25/Mtok")).toBeInTheDocument();
  expect(within(fast).getByText("$2.00/Mtok")).toBeInTheDocument();
  expect(within(fast).getByText("Tools")).toBeInTheDocument();
});

test("offers a way in when a cost is unknown, rather than a blank that reads as free", async () => {
  renderChains({
    initial: withTiers({
      providers: [
        { provider: "anthropic", model: "claude-haiku-4-5", spec: { max_input_tokens: 200_000 } },
      ],
    }),
  });

  const fast = effortRow("Fast");
  expect(within(fast).queryByText(/\$/)).not.toBeInTheDocument();
  await userEvent.click(within(fast).getByRole("button", { name: "Change the Model model" }));
  await userEvent.click(await screen.findByRole("button", { name: /enter these by hand/i }));
  expect(await screen.findByLabelText("Input $ / 1M tokens")).toBeInTheDocument();
});

test("preserves the retired wire tier names when serializing", async () => {
  const onSubmit = renderChains();

  await touch();
  await save();

  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(Object.keys(submitted.tiers ?? {})).toEqual(["quick", "standard", "complex"]);
  expect(submitted.tiers?.quick.providers[0]?.model).toBe("claude-haiku-4-5");
  expect(submitted.embeddings).toEqual(initial.embeddings);
  expect(submitted.mode).toBe("advanced");
});

test("carries across entry fields this form cannot edit", async () => {
  // `constraints` and `budgets` are authored in soul.yaml and have no control here. Rebuilding an
  // entry from the fields the form knows about deleted them on every save.
  const entry = {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    constraints: { data_retention: "none" },
    budgets: { max_cost_usd: 2 },
  };
  const onSubmit = renderChains({ initial: withTiers({ providers: [entry] }) });

  await touch();
  await save();

  expect((onSubmit.mock.calls[0][0] as LlmConfig).tiers?.quick.providers[0]).toMatchObject({
    constraints: { data_retention: "none" },
    budgets: { max_cost_usd: 2 },
  });
});

test("reordering a chain changes which model is tried first", async () => {
  const onSubmit = renderChains({
    initial: withTiers({
      providers: [
        { provider: "anthropic", model: "claude-haiku-4-5" },
        { provider: "openai", model: "gpt-4o-mini" },
      ],
    }),
  });

  await userEvent.click(
    within(standbyList("Fast")).getByRole("button", { name: /move gpt-4o-mini earlier/i })
  );
  await save();

  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.tiers?.quick.providers.map((p) => p.model)).toEqual([
    "gpt-4o-mini",
    "claude-haiku-4-5",
  ]);
});

test("blocks saving a chain whose provider has no stored credential", async () => {
  const onSubmit = renderChains({ secretKeys: ["openai-api-key"] });

  await touch();
  await save();

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

test("changing an effort's model writes it back", async () => {
  vi.mocked(getModelOptions).mockResolvedValue({
    models: ["claude-haiku-4-5", "claude-sonnet-4-6"],
    source: "catalog",
  });
  const onSubmit = renderChains();

  await userEvent.click(
    within(effortRow("Fast")).getByRole("button", { name: "Change the Model model" })
  );
  await pickModel("claude-sonnet-4-6");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
  await save();

  expect((onSubmit.mock.calls[0][0] as LlmConfig).tiers?.quick.providers[0]?.model).toBe(
    "claude-sonnet-4-6"
  );
});

test("the Model field narrows a long catalogue instead of making you scroll it", async () => {
  vi.mocked(getModelOptions).mockResolvedValue({
    models: ["claude-haiku-4-5", "claude-sonnet-4-6", "gpt-4o-mini", "text-embedding-3-small"],
    source: "catalog",
  });
  renderChains();

  await userEvent.click(
    within(effortRow("Fast")).getByRole("button", { name: "Change the Model model" })
  );
  const model = await screen.findByRole("combobox", { name: "Model" });
  await userEvent.clear(model);
  await userEvent.type(model, "sonnet");

  const listbox = screen.getByRole("listbox");
  expect(within(listbox).getAllByRole("option")).toHaveLength(1);
  expect(within(listbox).getByRole("option", { name: "claude-sonnet-4-6" })).toBeInTheDocument();
});

test("an ID the catalogue has never heard of is still accepted as typed", async () => {
  vi.mocked(getModelOptions).mockResolvedValue({
    models: ["claude-haiku-4-5", "claude-sonnet-4-6"],
    source: "catalog",
  });
  const onSubmit = renderChains();

  await userEvent.click(
    within(effortRow("Fast")).getByRole("button", { name: "Change the Model model" })
  );
  const model = await screen.findByRole("combobox", { name: "Model" });
  await userEvent.clear(model);
  // A private Azure deployment is never in the catalogue; the field must not force a listed value.
  await userEvent.type(model, "my-private-deployment");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
  await save();

  expect((onSubmit.mock.calls[0][0] as LlmConfig).tiers?.quick.providers[0]?.model).toBe(
    "my-private-deployment"
  );
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

  await userEvent.click(
    within(effortRow("Fast")).getByRole("button", { name: "Change the Model model" })
  );
  const model = await screen.findByLabelText("Model");
  await userEvent.clear(model);
  await userEvent.type(model, "kimi-k2.5");
  await userEvent.tab();

  await userEvent.click(await screen.findByRole("button", { name: "azure_ai/kimi-k2.5" }));
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
  await save();

  expect((onSubmit.mock.calls[0][0] as LlmConfig).tiers?.quick.providers[0]?.spec).toMatchObject({
    litellm_key: "azure_ai/kimi-k2.5",
    max_input_tokens: 256000,
  });
});

test("accepts a manual context window when the catalogue has no match", async () => {
  const onSubmit = renderChains();

  await userEvent.click(
    within(effortRow("Fast")).getByRole("button", { name: "Change the Model model" })
  );
  const model = await screen.findByLabelText("Model");
  await userEvent.clear(model);
  await userEvent.type(model, "private-model");
  await userEvent.tab();

  // A catalogue miss ("unmatched") shows the manual fields directly, with no extra click needed.
  await userEvent.type(await screen.findByLabelText("Context window"), "131072");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
  await save();

  expect((onSubmit.mock.calls[0][0] as LlmConfig).tiers?.quick.providers[0]?.spec).toEqual({
    max_input_tokens: 131072,
  });
});

test("a hand-entered price is stored per token and leaves the context window alone", async () => {
  const onSubmit = renderChains({
    initial: withTiers({
      providers: [
        { provider: "anthropic", model: "claude-haiku-4-5", spec: { max_input_tokens: 200_000 } },
      ],
    }),
  });

  await userEvent.click(
    within(effortRow("Fast")).getByRole("button", { name: "Change the Model model" })
  );
  await userEvent.click(await screen.findByRole("button", { name: /enter these by hand/i }));
  await userEvent.type(await screen.findByLabelText("Input $ / 1M tokens"), "0.25");
  await userEvent.type(screen.getByLabelText("Output $ / 1M tokens"), "2");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
  await save();

  // Writing a price must merge into the spec: dropping max_input_tokens here is a 422 from the
  // server, because every tier entry has to declare the capacity a turn is budgeted against.
  expect((onSubmit.mock.calls[0][0] as LlmConfig).tiers?.quick.providers[0]?.spec).toEqual({
    max_input_tokens: 200_000,
    input_cost_per_token: 0.00000025,
    output_cost_per_token: 0.000002,
  });
});

test("adding a standby creates a numbered profile", async () => {
  const onSubmit = renderChains();

  await userEvent.click(within(standbyList("Fast")).getByRole("button", { name: /add standby/i }));

  await userEvent.selectOptions(await screen.findByLabelText("Provider"), "openai");
  await userEvent.type(await screen.findByLabelText("Model"), "gpt-4o-mini");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));

  await waitFor(() => {
    expect(within(standbyList("Fast")).getAllByText(/fast-fallback-1/).length).toBeGreaterThan(0);
  });

  await save();
  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.tiers?.quick.providers).toHaveLength(2);
  expect(submitted.tiers?.quick.providers[1]).toMatchObject({
    provider: "openai",
    model: "gpt-4o-mini",
  });
});

test("an empty standby model stays in the sheet and is not committed to the chain", async () => {
  renderChains();

  await userEvent.click(within(standbyList("Fast")).getByRole("button", { name: /add standby/i }));
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));

  expect(screen.getByText("Enter a model.")).toBeInTheDocument();
  expect(within(standbyList("Fast")).queryByText(/fast-fallback-1/)).not.toBeInTheDocument();

  await userEvent.type(screen.getByLabelText("Model"), "gpt-4o-mini");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));

  expect(within(standbyList("Fast")).getByText(/fast-fallback-1/)).toBeInTheDocument();
});

test("an incomplete standby never enters the chain, even before Done is pressed", async () => {
  renderChains();

  await userEvent.click(within(standbyList("Fast")).getByRole("button", { name: /add standby/i }));

  expect(within(standbyList("Fast")).getAllByRole("listitem")).toHaveLength(1);
  expect(within(standbyList("Fast")).queryByText(/no model set/i)).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /^close$/i }));

  expect(within(standbyList("Fast")).getAllByRole("listitem")).toHaveLength(1);
  expectNoUnsavedChanges();
});

test("a standby with no provider selected stays in the sheet with a field error", async () => {
  renderChains();

  await userEvent.click(within(standbyList("Fast")).getByRole("button", { name: /add standby/i }));
  await userEvent.selectOptions(await screen.findByLabelText("Provider"), "");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));

  expect(screen.getByText("Select a provider.")).toBeInTheDocument();
  expect(within(standbyList("Fast")).getAllByRole("listitem")).toHaveLength(1);
});

test("a whitespace-only standby model is refused like an empty one", async () => {
  renderChains();

  await userEvent.click(within(standbyList("Fast")).getByRole("button", { name: /add standby/i }));
  await userEvent.type(await screen.findByLabelText("Model"), "   ");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));

  expect(screen.getByText("Enter a model.")).toBeInTheDocument();
  expect(within(standbyList("Fast")).getAllByRole("listitem")).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: /^close$/i }));
  expectNoUnsavedChanges();
});

test("abandoning an edit that emptied the model leaves the entry intact", async () => {
  renderChains();

  await userEvent.click(
    within(effortRow("Fast")).getByRole("button", { name: "Change the Model model" })
  );
  await userEvent.clear(await screen.findByLabelText("Model"));
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
  expect(screen.getByText("Enter a model.")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /^close$/i }));

  expect(effortRow("Fast")).toHaveTextContent("claude-haiku-4-5");

  // Re-opening the row must not carry the refusal that the discarded edit raised.
  await userEvent.click(
    within(effortRow("Fast")).getByRole("button", { name: "Change the Model model" })
  );
  expect(await screen.findByLabelText("Model")).toHaveValue("claude-haiku-4-5");
  expect(screen.queryByText("Enter a model.")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^close$/i }));

  expectNoUnsavedChanges();
});

test("the default effort is chosen on the card it applies to, not in a separate control", async () => {
  const onSubmit = renderChains();

  // It decides what nearly every turn costs, so it belongs beside the cost it selects.
  expect(within(effortRow("Balanced")).getByRole("radio")).toBeChecked();
  expect(within(effortRow("Fast")).getByRole("radio")).not.toBeChecked();

  await userEvent.click(within(effortRow("Thorough")).getByRole("radio"));
  await save();

  expect((onSubmit.mock.calls[0][0] as LlmConfig).presets?.default).toBe("thorough");
});

test("names which slots are unsaved rather than only that something is", async () => {
  // Editing in a card updates it but saves nothing, so a bar that says only "unsaved changes"
  // leaves you re-auditing the page to find what you touched.
  renderChains();
  expectNoUnsavedChanges();

  await touch();

  expect(screen.getByText(/not saved yet/i)).toBeInTheDocument();
  expect(screen.getByText("Default")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /save changes/i })).toBeEnabled();
});

test("Discard puts back the config as loaded", async () => {
  const onSubmit = renderChains();

  await touch();
  await userEvent.click(screen.getByRole("button", { name: /discard/i }));

  expect(within(effortRow("Balanced")).getByRole("radio")).toBeChecked();
  expectNoUnsavedChanges();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("a default pointing at a retired standby id is silently resolved to Balanced", () => {
  // The preset radios only ever name Fast/Balanced/Thorough; a `presets.default` that names
  // anything else (e.g. a standby profile id from a config authored outside this form) has no
  // radio to land on, so it is coerced back to the safe default rather than left unrepresentable.
  renderChains({
    initial: {
      ...withTiers({
        providers: [
          { provider: "anthropic", model: "claude-haiku-4-5" },
          { provider: "openai", model: "gpt-4o-mini" },
        ],
      }),
      presets: { default: "fast-fallback-1", fast: "fast" },
    },
  });

  expect(within(effortRow("Balanced")).getByRole("radio")).toBeChecked();
  expect(within(effortRow("Fast")).getByRole("radio")).not.toBeChecked();
  expect(within(effortRow("Thorough")).getByRole("radio")).not.toBeChecked();
});

test("switching to Basic and saving over per-effort differences asks for confirmation first", async () => {
  const onSubmit = renderChains();

  await switchToTab("Basic");
  await userEvent.click(screen.getByRole("button", { name: "Change the Chat model model" }));
  const model = await screen.findByLabelText("Model");
  await userEvent.clear(model);
  await userEvent.type(model, "claude-opus-5");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
  await save();

  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText(/drop the per-effort models and standby chains/i)
  ).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Switch to Basic" }));

  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.mode).toBe("basic");
  expect(submitted.tiers?.quick.providers[0]?.model).toBe("claude-opus-5");
  expect(submitted.tiers?.standard.providers[0]?.model).toBe("claude-opus-5");
  expect(submitted.tiers?.complex.providers[0]?.model).toBe("claude-opus-5");
});

test("shows the configured embedding model and what depends on it", () => {
  renderChains({
    initial: {
      ...initial,
      embeddings: {
        providers: [
          {
            provider: "openai",
            model: "text-embedding-3-small",
            dimension: 1536,
            spec: { input_cost_per_token: 0.000000005 },
          },
        ],
      },
    },
  });

  const row = screen.getByRole("heading", { name: "Embedding", level: 4 }).closest("section");
  expect(row).toHaveTextContent("text-embedding-3-small");
  expect(row).toHaveTextContent("OpenAI");
  expect(row).toHaveTextContent("1536");
  // Sub-cent rates must not round to $0.00 and read as free.
  expect(row).toHaveTextContent("$0.0050/Mtok");
  expect(row).toHaveTextContent(/re-index knowledge/i);
});

test("sets an embedding model and its vector width from the page", async () => {
  vi.mocked(getModelOptions).mockResolvedValue({
    models: ["text-embedding-3-small", "text-embedding-3-large"],
    source: "catalog",
  });
  const onSubmit = renderChains({ initial: basicModeInitial });

  await switchToTab("Basic");
  await userEvent.click(screen.getByRole("button", { name: "Change the Embedding model model" }));
  await pickModel("text-embedding-3-large");
  const width = await screen.findByLabelText("Vector width");
  await userEvent.clear(width);
  await userEvent.type(width, "3072");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
  await save();

  expect((onSubmit.mock.calls[0][0] as LlmConfig).embeddings?.providers[0]).toMatchObject({
    provider: "openai",
    model: "text-embedding-3-large",
    dimension: 3072,
  });
  // Embedding suggestions must not be the chat catalogue.
  expect(getModelOptions).toHaveBeenCalledWith("openai", "embedding");
});

test("offers an embedding model when none is configured", async () => {
  const onSubmit = renderChains({ initial: { ...basicModeInitial, embeddings: undefined } });

  await switchToTab("Basic");
  const row = screen.getByRole("region", { name: "Embedding model" });
  expect(within(row).getByText("Not set.")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Choose a Embedding model model" }));
  await userEvent.selectOptions(await screen.findByLabelText("Provider"), "openai");
  await userEvent.type(await screen.findByLabelText("Model"), "text-embedding-3-small");
  await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
  await save();

  expect((onSubmit.mock.calls[0][0] as LlmConfig).embeddings?.providers).toEqual([
    { provider: "openai", model: "text-embedding-3-small" },
  ]);
});

test("blocks saving an embedding model whose provider has no credential", async () => {
  const onSubmit = renderChains({ secretKeys: ["anthropic-api-key"] });

  await touch();
  await save();

  expect(onSubmit).not.toHaveBeenCalled();
  expect(await screen.findByRole("alert")).toHaveTextContent(/embedding model uses OpenAI/i);
});

test("says image generation is unsupported rather than leaving the reader to guess", () => {
  renderChains();

  // One line, not a panel: a whole panel whose only message is "no" claims real estate to say
  // nothing, and reads as a control that is merely broken.
  expect(screen.getByText(/image generation/i).closest("p")).toHaveTextContent(
    /not supported yet/i
  );
  expect(screen.queryByRole("heading", { name: "Image model" })).not.toBeInTheDocument();
});

test("a connection test quotes what the model actually replied", async () => {
  // A verdict alone cannot tell a working model from an endpoint that returns 200 and no text.
  vi.mocked(testLlmConnection).mockResolvedValue({
    verdict: "reachable",
    reply: "pong",
    latencyMs: 412,
  });
  renderChains();

  await userEvent.click(
    within(effortRow("Fast")).getByRole("button", { name: "Change the Model model" })
  );
  await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));

  expect(await screen.findByText(/Replied .pong. in 412 ms/)).toBeInTheDocument();
  expect(vi.mocked(testLlmConnection).mock.calls[0][1]).toBe("chat");
});

test("a model that answers with something else is still a pass, but is quoted as one", async () => {
  // The deployment is healthy, so the probe keeps its green verdict and the status page stays
  // quiet. The operator standing on this screen still needs to see the model ignored the prompt.
  vi.mocked(testLlmConnection).mockResolvedValue({
    verdict: "reachable",
    reply: "Sure, how can I help?",
    answeredAsAsked: false,
    latencyMs: 88,
  });
  renderChains();

  await userEvent.click(
    within(effortRow("Fast")).getByRole("button", { name: "Change the Model model" })
  );
  await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));

  expect(
    await screen.findByText(/Answered .Sure, how can I help\?. in 88 ms, not the word/)
  ).toBeInTheDocument();
});

test("a provider that answers but refuses reads differently from one that never answered", async () => {
  vi.mocked(testLlmConnection).mockResolvedValue({
    verdict: "degraded",
    detail: "the provider is rate limiting this deployment",
  });
  renderChains();

  await userEvent.click(
    within(effortRow("Fast")).getByRole("button", { name: "Change the Model model" })
  );
  await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));

  expect(await screen.findByText(/answered, but refused this call/i)).toBeInTheDocument();
  expect(screen.getByText(/rate limiting/i)).toBeInTheDocument();
});

test("a verdict is dropped once the model it was about is changed", async () => {
  vi.mocked(getModelOptions).mockResolvedValue({
    models: ["claude-haiku-4-5", "claude-sonnet-4-6"],
    source: "catalog",
  });
  vi.mocked(testLlmConnection).mockResolvedValue({ verdict: "reachable", reply: "pong" });
  renderChains();

  await userEvent.click(
    within(effortRow("Fast")).getByRole("button", { name: "Change the Model model" })
  );
  await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));
  expect(await screen.findByText(/Replied/)).toBeInTheDocument();

  await pickModel("claude-sonnet-4-6");

  // Leaving the pass on screen would claim a model was proved that was never called.
  await waitFor(() => expect(screen.queryByText(/Replied/)).not.toBeInTheDocument());
  expect(screen.getByText(/not tested/i)).toBeInTheDocument();
});

test("testing an embedding model offers the width it measured", async () => {
  vi.mocked(testLlmConnection).mockResolvedValue({ verdict: "reachable", dimension: 1536 });
  renderChains({
    initial: {
      ...initial,
      embeddings: { providers: [{ provider: "openai", model: "text-embedding-3-small" }] },
    },
  });

  await switchToTab("Basic");
  await userEvent.click(screen.getByRole("button", { name: /change the embedding model/i }));
  await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));

  expect(await screen.findByText(/Embedded a 1536-wide vector/)).toBeInTheDocument();
  expect(vi.mocked(testLlmConnection).mock.calls[0][1]).toBe("embedding");

  // The width is the one number an operator cannot guess and cannot change later without a
  // re-index, so a measured value is offered rather than left to be retyped.
  await userEvent.click(screen.getByRole("button", { name: /use 1536 as the vector width/i }));
  expect(screen.getByLabelText("Vector width")).toHaveValue(1536);
});

test("a failure does not send the operator to the page they are already on", async () => {
  // The probe's detail is shared with the status page, where naming the screen is the whole point.
  vi.mocked(testLlmConnection).mockResolvedValue({
    verdict: "unreachable",
    detail:
      "bad-model — the provider has no model by the configured id — choose another under Business → Models",
  });
  renderChains();

  await userEvent.click(
    within(effortRow("Fast")).getByRole("button", { name: "Change the Model model" })
  );
  await userEvent.click(await screen.findByRole("button", { name: /test connection/i }));

  expect(await screen.findByText(/no model by the configured id/i)).toBeInTheDocument();
  expect(screen.queryByText(/under Business/i)).not.toBeInTheDocument();
});

test("the save bar clears once the saved config comes back from the loader", async () => {
  const onSubmit = vi.fn();
  const props = {
    initial,
    providers: PROVIDERS,
    secretKeys: ALL_SECRETS,
    onSubmit,
    submitting: false,
    formError: null,
  };
  const { rerender } = render(<ModelChains {...props} />);

  await touch();
  await save();
  const saved = onSubmit.mock.calls[0][0] as LlmConfig;

  // A successful save revalidates the loader; Remix hands the fresh config back through props
  // without remounting. A baseline captured at mount would survive that and keep the bar lit,
  // offering to save work already on disk — the exact confusion the bar exists to remove.
  rerender(<ModelChains {...props} initial={saved} />);

  expectNoUnsavedChanges();
  expect(screen.queryByRole("button", { name: /discard/i })).not.toBeInTheDocument();
});
