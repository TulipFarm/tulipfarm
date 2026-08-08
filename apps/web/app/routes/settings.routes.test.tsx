import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import type { LlmProviderInfo } from "~/lib/settings";
import * as settings from "~/lib/settings";
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

test("groups a provider's stored fields into one collapsible row and shows config values", async () => {
  renderWithData(<SettingsSecrets />, {
    secrets: [
      { key: "azure-openai-api-key", ...meta },
      { key: "azure-openai-resource-name", ...meta },
    ],
    providers: PROVIDERS,
    config: { "azure-openai-resource-name": "my-res" },
  });
  // "Azure Foundry" shows as one grouped row (a configured provider is no longer offered in the add
  // picker) — proven by one "2 fields" badge + one Delete (not two per-key rows).
  expect(screen.getAllByText("Azure Foundry").length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText("2 fields")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /delete/i })).toHaveLength(1);
  // Expand to edit: config value (resource name) prefills; the secret stays blank/write-only.
  await userEvent.click(screen.getByRole("button", { name: /^edit$/i }));
  expect(screen.getByLabelText("azure resource_name")).toHaveValue("my-res");
  expect(screen.getByLabelText("azure api_key")).toHaveValue("");
});

test("editing a provider inline saves only the changed fields", async () => {
  renderWithData(<SettingsSecrets />, {
    secrets: [
      { key: "azure-openai-api-key", ...meta },
      { key: "azure-openai-resource-name", ...meta },
    ],
    providers: PROVIDERS,
    config: { "azure-openai-resource-name": "my-res" },
  });
  // Edit happens in the row itself (expand it), then change the resource name and Save.
  await userEvent.click(screen.getByRole("button", { name: /^edit$/i }));
  const resource = screen.getByLabelText("azure resource_name");
  await userEvent.clear(resource);
  await userEvent.type(resource, "new-res");
  await userEvent.click(screen.getByRole("button", { name: /^save$/i })); // the row's inline Save
  expect(settings.putSecret).toHaveBeenCalledWith("azure-openai-resource-name", "new-res");
  // The untouched (blank) API key is left as-is — not re-written.
  expect(settings.putSecret).not.toHaveBeenCalledWith("azure-openai-api-key", expect.anything());
});

test("a configured provider is not offered in the add picker (managed via Edit only)", () => {
  renderWithData(<SettingsSecrets />, {
    secrets: [
      { key: "azure-openai-api-key", ...meta },
      { key: "azure-openai-resource-name", ...meta },
    ],
    providers: PROVIDERS,
    config: {},
  });
  const picker = screen.getByLabelText("secret provider");
  const optionLabels = within(picker)
    .getAllByRole("option")
    .map((o) => o.textContent);
  expect(optionLabels).not.toContain("Azure Foundry"); // already configured → excluded
  expect(optionLabels).toContain("Anthropic"); // nothing stored → still offered
});

test("selecting Custom… in the add picker reveals key/value fields and stores under the typed key", async () => {
  renderWithData(<SettingsSecrets />, { secrets: [], providers: PROVIDERS, config: {} });
  await userEvent.selectOptions(screen.getByLabelText("secret provider"), "Custom…");
  await userEvent.type(screen.getByLabelText("secret key"), "stripe-api-key");
  await userEvent.type(screen.getByLabelText("secret value"), "sk_live_x");
  await userEvent.click(screen.getByRole("button", { name: /save provider/i }));
  expect(settings.putSecret).toHaveBeenCalledWith("stripe-api-key", "sk_live_x");
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
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: /delete/i }));
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
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: /delete/i }));
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
  expect(settings.putLlmConfig).toHaveBeenCalledWith({
    ...llmConfig,
    presets: {
      default: "balanced",
      fast: "fast",
      balanced: "balanced",
      thorough: "thorough",
    },
  });
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
