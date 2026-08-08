import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { LlmConfigForm } from "~/components/llm-config-form";
import { getModelOptions, type LlmConfig, type LlmProviderInfo } from "~/lib/settings";

vi.mock("~/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/settings")>();
  return {
    ...actual,
    getModelOptions: vi.fn().mockResolvedValue({ models: [], source: "unavailable" }),
    resolveModelSpec: vi.fn().mockResolvedValue({ spec: null, matchedKey: null, candidates: [] }),
  };
});

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
  {
    id: "azure",
    label: "Azure Foundry",
    fields: [
      { key: "azure-openai-api-key", label: "API key", role: "api_key", kind: "secret" },
      {
        key: "azure-openai-resource-name",
        label: "Resource name",
        role: "resource_name",
        kind: "config",
      },
    ],
  },
];

const ALL_SECRETS = [
  "anthropic-api-key",
  "openai-api-key",
  "azure-openai-api-key",
  "azure-openai-resource-name",
  "azure-secondary-key",
];

const initial: LlmConfig = {
  presets: { default: "balanced" },
  tiers: {
    quick: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
    standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
    complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
  },
  embeddings: { providers: [{ provider: "openai", model: "text-embedding-3-small" }] },
};

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(getModelOptions).mockResolvedValue({ models: [], source: "unavailable" });
});

test("renders Effort Preset mappings and the ordered provider chains", () => {
  render(
    <LlmConfigForm
      initial={initial}
      providers={PROVIDERS}
      secretKeys={ALL_SECRETS}
      onSubmit={vi.fn()}
      submitting={false}
    />
  );

  expect(screen.getByText("Effort Presets")).toBeInTheDocument();
  expect(screen.getByLabelText("Auto default ModelProfile")).toHaveValue("balanced");
  expect(screen.getByText(/Auto resolves to the default/i)).toBeInTheDocument();
  expect(screen.getAllByText("Fast").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Balanced").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Thorough").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Primary")).toHaveLength(3);
  expect(screen.getByDisplayValue("claude-haiku-4-5")).toBeInTheDocument();
});

test("editing preset mappings submits presets alongside preserved provider chains", async () => {
  const onSubmit = vi.fn();
  render(
    <LlmConfigForm
      initial={initial}
      providers={PROVIDERS}
      secretKeys={ALL_SECRETS}
      onSubmit={onSubmit}
      submitting={false}
    />
  );

  await userEvent.selectOptions(screen.getByLabelText("Auto default ModelProfile"), "fast");
  await userEvent.selectOptions(screen.getByLabelText("Thorough ModelProfile"), "thorough");
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

  expect(onSubmit).toHaveBeenCalledWith({
    ...initial,
    presets: {
      default: "fast",
      fast: "fast",
      balanced: "balanced",
      thorough: "thorough",
    },
  });
});

test("shows distinct Provider Connections for different credential tuples", () => {
  const config: LlmConfig = {
    presets: { default: "fast" },
    tiers: {
      quick: {
        providers: [
          {
            provider: "azure",
            model: "gpt-4o",
            api_key_ref: "azure-openai-api-key",
            resource_name: "primary-res",
          },
          {
            provider: "azure",
            model: "gpt-4o-mini",
            api_key_ref: "azure-secondary-key",
            resource_name: "secondary-res",
          },
        ],
      },
      standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
      complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
    },
  };

  render(
    <LlmConfigForm
      initial={config}
      providers={PROVIDERS}
      secretKeys={ALL_SECRETS}
      onSubmit={vi.fn()}
      submitting={false}
    />
  );

  expect(screen.getByText("Provider Connection azure")).toBeInTheDocument();
  expect(screen.getByText("Provider Connection azure-2")).toBeInTheDocument();
  expect(screen.getByText("API key ref: azure-openai-api-key")).toBeInTheDocument();
  expect(screen.getByText("API key ref: azure-secondary-key")).toBeInTheDocument();
});

test("serializes row-level Provider Connection fields", async () => {
  const onSubmit = vi.fn();
  render(
    <LlmConfigForm
      initial={initial}
      providers={PROVIDERS}
      secretKeys={ALL_SECRETS}
      onSubmit={onSubmit}
      submitting={false}
    />
  );

  await userEvent.type(screen.getByLabelText("Fast provider 1 api key ref"), "anthropic-api-key");
  await userEvent.type(screen.getByLabelText("Fast provider 1 base url"), "https://llm.example");
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.tiers?.quick.providers[0]).toEqual({
    provider: "anthropic",
    model: "claude-haiku-4-5",
    api_key_ref: "anthropic-api-key",
    base_url: "https://llm.example",
  });
  expect(submitted.embeddings).toEqual(initial.embeddings);
});

test("blocks save when a row's Provider Connection is not fully configured", async () => {
  const onSubmit = vi.fn();
  const cfg: LlmConfig = {
    tiers: {
      quick: { providers: [{ provider: "azure", model: "gpt-4o" }] },
      standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
      complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
    },
  };
  render(
    <LlmConfigForm
      initial={cfg}
      providers={PROVIDERS}
      secretKeys={["anthropic-api-key", "azure-openai-api-key"]}
      onSubmit={onSubmit}
      submitting={false}
    />
  );

  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(/Provider Connection secret or config/i);
});

test("adding a provider row adds a fallback profile option and submits the chain", async () => {
  const onSubmit = vi.fn();
  render(
    <LlmConfigForm
      initial={initial}
      providers={PROVIDERS}
      secretKeys={ALL_SECRETS}
      onSubmit={onSubmit}
      submitting={false}
    />
  );

  await userEvent.click(
    screen.getAllByRole("button", { name: /add provider to fallback chain/i })[0]
  );
  await userEvent.type(screen.getByLabelText("Fast provider 2 model"), "claude-3-5-haiku");
  expect(screen.getByText("fast-fallback-1")).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText("Fast ModelProfile"), "fast-fallback-1");
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.presets?.fast).toBe("fast-fallback-1");
  expect(submitted.tiers?.quick.providers).toEqual([
    { provider: "anthropic", model: "claude-haiku-4-5" },
    { provider: "anthropic", model: "claude-3-5-haiku" },
  ]);
});

test("the model picker lists catalog suggestions in a datalist for non-Azure providers", async () => {
  vi.mocked(getModelOptions).mockResolvedValue({
    models: ["claude-haiku-4-5", "claude-opus-4-8"],
    source: "catalog",
  });
  render(
    <LlmConfigForm
      initial={initial}
      providers={PROVIDERS}
      secretKeys={ALL_SECRETS}
      onSubmit={vi.fn()}
      submitting={false}
    />
  );

  await userEvent.click(screen.getByLabelText("Fast provider 1 model"));
  await waitFor(() =>
    expect(
      document.querySelector('#models-anthropic option[value="claude-opus-4-8"]')
    ).toBeInTheDocument()
  );
});

test("Azure keeps provider model id free text and submits custom deployment names", async () => {
  const onSubmit = vi.fn();
  const azureInitial: LlmConfig = {
    tiers: {
      quick: { providers: [{ provider: "azure", model: "gpt-4o" }] },
      standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
      complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
    },
  };
  render(
    <LlmConfigForm
      initial={azureInitial}
      providers={PROVIDERS}
      secretKeys={ALL_SECRETS}
      onSubmit={onSubmit}
      submitting={false}
    />
  );

  const input = screen.getByLabelText("Fast provider 1 model");
  await userEvent.click(input);
  expect(getModelOptions).not.toHaveBeenCalledWith("azure");
  expect(document.querySelector("#models-azure")).toBeNull();
  await userEvent.clear(input);
  await userEvent.type(input, "my-custom-deploy");
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.tiers?.quick.providers[0]).toEqual({
    provider: "azure",
    model: "my-custom-deploy",
  });
});

test("a pinned spec renders as metadata badges", () => {
  const withSpec: LlmConfig = {
    tiers: {
      quick: {
        providers: [
          {
            provider: "anthropic",
            model: "claude-haiku-4-5",
            spec: {
              input_cost_per_token: 0.0000008,
              output_cost_per_token: 0.000004,
              max_input_tokens: 200000,
              supports_function_calling: true,
            },
          },
        ],
      },
      standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
      complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
    },
  };
  render(
    <LlmConfigForm
      initial={withSpec}
      providers={PROVIDERS}
      secretKeys={ALL_SECRETS}
      onSubmit={vi.fn()}
      submitting={false}
    />
  );

  expect(screen.getByText("$0.80 / $4.00 per Mtok")).toBeInTheDocument();
  expect(screen.getByText("200k ctx")).toBeInTheDocument();
  expect(screen.getByText("tools")).toBeInTheDocument();
});
