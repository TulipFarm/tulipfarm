import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import * as settings from "~/lib/settings";
import type { LlmProviderInfo } from "~/lib/settings";
import SettingsLlm from "./_app.settings.llm";
import SettingsSecrets from "./_app.settings.secrets";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRouteError: vi.fn(),
    useRevalidator: vi.fn(() => ({ revalidate: vi.fn(), state: "idle" })),
  };
});

vi.mock("~/lib/settings", async () => {
  const actual = await vi.importActual<typeof import("~/lib/settings")>("~/lib/settings");
  return {
    ...actual,
    putSecret: vi.fn().mockResolvedValue(undefined),
    deleteSecret: vi.fn().mockResolvedValue(undefined),
    putLlmConfig: vi.fn(),
  };
});

const PROVIDERS: LlmProviderInfo[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    fields: [{ key: "anthropic-api-key", label: "API key", role: "api_key", kind: "secret" }],
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

const llmConfig = {
  tiers: {
    quick: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
    standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
    complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
  },
};

function renderWithData(node: ReactElement, data: unknown) {
  vi.mocked(remix.useLoaderData).mockReturnValue(data);
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  render(<Stub initialEntries={["/"]} />);
}

afterEach(() => {
  vi.clearAllMocks();
});

// --- Secrets ---

const meta = { type: "user-provided" as const, createdAt: "x", updatedAt: "y" };

test("groups a provider's stored fields into one collapsible row and shows config values", () => {
  renderWithData(<SettingsSecrets />, {
    secrets: [
      { key: "azure-openai-api-key", ...meta },
      { key: "azure-openai-resource-name", ...meta },
    ],
    providers: PROVIDERS,
    config: { "azure-openai-resource-name": "my-res" },
  });
  // "Azure OpenAI" appears in both the row and the configure dropdown — the single grouped row is
  // proven by one "2 fields" badge + one Delete (not two per-key rows).
  expect(screen.getAllByText("Azure OpenAI").length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText("2 fields")).toBeInTheDocument();
  expect(screen.getByText("my-res")).toBeInTheDocument(); // config value shown back
  expect(screen.getByText("•••••••• (set)")).toBeInTheDocument(); // secret value masked
  expect(screen.getAllByRole("button", { name: /delete/i })).toHaveLength(1);
});

test("editing a provider loads it into the form with config values prefilled", async () => {
  renderWithData(<SettingsSecrets />, {
    secrets: [
      { key: "azure-openai-api-key", ...meta },
      { key: "azure-openai-resource-name", ...meta },
    ],
    providers: PROVIDERS,
    config: { "azure-openai-resource-name": "my-res" },
  });
  await userEvent.click(screen.getByRole("button", { name: /edit/i }));
  expect(screen.getByLabelText("secret provider")).toHaveValue("azure");
  expect(screen.getByLabelText("azure resource_name")).toHaveValue("my-res");
});

test("configuring a multi-field provider stores every field under its registry key", async () => {
  renderWithData(<SettingsSecrets />, { secrets: [], providers: PROVIDERS, config: {} });
  await userEvent.selectOptions(screen.getByLabelText("secret provider"), "azure");
  await userEvent.type(screen.getByLabelText("azure api_key"), "az-key");
  await userEvent.type(screen.getByLabelText("azure resource_name"), "my-res");
  await userEvent.click(screen.getByRole("button", { name: /save provider/i }));
  expect(settings.putSecret).toHaveBeenCalledWith("azure-openai-api-key", "az-key");
  expect(settings.putSecret).toHaveBeenCalledWith("azure-openai-resource-name", "my-res");
});

test("a 403 on write surfaces an admin-only message", async () => {
  vi.mocked(settings.putSecret).mockRejectedValueOnce(new ApiError(403, "forbidden"));
  renderWithData(<SettingsSecrets />, { secrets: [], providers: PROVIDERS, config: {} });
  await userEvent.type(screen.getByLabelText("anthropic api_key"), "sk");
  await userEvent.click(screen.getByRole("button", { name: /save provider/i }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/admin only/i));
});

test("deleting a provider removes all of its stored field keys", async () => {
  renderWithData(<SettingsSecrets />, {
    secrets: [
      { key: "azure-openai-api-key", ...meta },
      { key: "azure-openai-resource-name", ...meta },
    ],
    providers: PROVIDERS,
    config: {},
  });
  await userEvent.click(screen.getByRole("button", { name: /delete/i }));
  expect(settings.deleteSecret).toHaveBeenCalledWith("azure-openai-api-key");
  expect(settings.deleteSecret).toHaveBeenCalledWith("azure-openai-resource-name");
});

test("a custom (non-provider) secret lists individually and deletes by its key", async () => {
  renderWithData(<SettingsSecrets />, {
    secrets: [{ key: "stale-key", ...meta }],
    providers: PROVIDERS,
    config: {},
  });
  await userEvent.click(screen.getByRole("button", { name: /delete/i }));
  expect(settings.deleteSecret).toHaveBeenCalledWith("stale-key");
});

// --- LLM config ---

test("llm pane saves the structured config via putLlmConfig", async () => {
  vi.mocked(settings.putLlmConfig).mockResolvedValueOnce(llmConfig);
  renderWithData(<SettingsLlm />, {
    config: llmConfig,
    providers: PROVIDERS,
    secretKeys: ["anthropic-api-key"],
  });
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
  expect(settings.putLlmConfig).toHaveBeenCalledWith(llmConfig);
  await waitFor(() => expect(screen.getByText(/reloaded/i)).toBeInTheDocument());
});

test("a 403 saving the llm config surfaces an admin-only message", async () => {
  vi.mocked(settings.putLlmConfig).mockRejectedValueOnce(new ApiError(403, "forbidden"));
  renderWithData(<SettingsLlm />, {
    config: llmConfig,
    providers: PROVIDERS,
    secretKeys: ["anthropic-api-key"],
  });
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/admin only/i));
});
