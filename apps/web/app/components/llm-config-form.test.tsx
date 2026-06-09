import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { LlmConfigForm } from "~/components/llm-config-form";
import type { LlmConfig, LlmProviderInfo } from "~/lib/settings";

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
    label: "Azure OpenAI",
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
];

const initial: LlmConfig = {
  tiers: {
    quick: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
    standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
    complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
  },
  embeddings: { providers: [{ provider: "openai", model: "text-embedding-3-small" }] },
};

test("renders the three tiers with their current models", () => {
  render(
    <LlmConfigForm
      initial={initial}
      providers={PROVIDERS}
      secretKeys={ALL_SECRETS}
      onSubmit={vi.fn()}
      submitting={false}
    />
  );
  expect(screen.getByText("quick")).toBeInTheDocument();
  expect(screen.getByDisplayValue("claude-haiku-4-5")).toBeInTheDocument();
  expect(screen.getByDisplayValue("claude-opus-4-8")).toBeInTheDocument();
});

test("a provider that is not fully configured is disabled in the dropdown", () => {
  // Only anthropic's key is set; azure is missing its resource_name → not configured.
  render(
    <LlmConfigForm
      initial={initial}
      providers={PROVIDERS}
      secretKeys={["anthropic-api-key", "azure-openai-api-key"]}
      onSubmit={vi.fn()}
      submitting={false}
    />
  );
  expect(
    screen.getAllByRole("option").find((o) => o.textContent === "OpenAI — configure first")
  ).toBeDisabled();
  expect(
    screen.getAllByRole("option").find((o) => o.textContent === "Azure OpenAI — configure first")
  ).toBeDisabled();
});

test("submitting serializes rows as {provider, model} only and round-trips embeddings", async () => {
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
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
  expect(onSubmit).toHaveBeenCalledWith(initial);
});

test("blocks save when a row's provider is not fully configured", async () => {
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
  expect(screen.getByRole("alert")).toHaveTextContent(/Azure OpenAI is not fully configured/i);
});

test("blocks save on a fresh empty config (a tier has no providers)", async () => {
  const onSubmit = vi.fn();
  const empty: LlmConfig = {
    tiers: { quick: { providers: [] }, standard: { providers: [] }, complex: { providers: [] } },
  };
  render(
    <LlmConfigForm
      initial={empty}
      providers={PROVIDERS}
      secretKeys={ALL_SECRETS}
      onSubmit={onSubmit}
      submitting={false}
    />
  );
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(/quick tier needs at least one provider/i);
});

test("adding a provider row is reflected in the submitted config", async () => {
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
  await userEvent.click(screen.getAllByRole("button", { name: /add provider/i })[0]);
  await userEvent.type(screen.getByLabelText("quick provider 2 model"), "claude-3-5-haiku");
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

  const submitted = onSubmit.mock.calls[0][0] as LlmConfig;
  expect(submitted.tiers.quick.providers).toEqual([
    { provider: "anthropic", model: "claude-haiku-4-5" },
    { provider: "anthropic", model: "claude-3-5-haiku" },
  ]);
});
