import { createRemixStub } from "@remix-run/testing";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type SessionUser } from "~/lib/api";
import { getLlmConfig, type LlmConfig } from "~/lib/settings";
import { ModelConfigurationWarning } from "./model-configuration-warning";

vi.mock("~/lib/settings", () => ({ getLlmConfig: vi.fn() }));

const admin = { isAdmin: true, role: "member" } as SessionUser;
const configured: LlmConfig = {
  tiers: {
    quick: { providers: [{ provider: "azure", model: "chat", api_key_ref: "secret://private" }] },
    standard: { providers: [{ provider: "azure", model: "chat" }] },
    complex: { providers: [{ provider: "azure", model: "chat" }] },
  },
};

function mount(user: SessionUser | undefined = admin) {
  const Stub = createRemixStub([
    { path: "/", Component: () => <ModelConfigurationWarning user={user} /> },
  ]);
  return render(<Stub />);
}

describe("ModelConfigurationWarning", () => {
  beforeEach(() => {
    vi.mocked(getLlmConfig).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns an authorized admin when no model remains, with a Models link", async () => {
    vi.mocked(getLlmConfig).mockResolvedValue({});
    mount();
    expect(await screen.findByRole("status")).toHaveTextContent("No model is configured");
    expect(screen.getByRole("link", { name: "Configure a model" })).toHaveAttribute(
      "href",
      "/business/models"
    );
  });

  it("does not mistake an embedding-only config for a chat model", async () => {
    vi.mocked(getLlmConfig).mockResolvedValue({
      embeddings: { providers: [{ provider: "openai", model: "embedding" }] },
    });
    mount();
    expect(await screen.findByRole("status")).toHaveTextContent("No model is configured");
  });

  it("hides the warning for a configured model and never renders provider credentials", async () => {
    vi.mocked(getLlmConfig).mockResolvedValue(configured);
    mount();
    await waitFor(() => expect(getLlmConfig).toHaveBeenCalledOnce());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("secret://private");
  });

  it("does not fetch admin configuration for a nonadmin, even with a legacy admin role", () => {
    mount({ isAdmin: false, role: "admin" } as SessionUser);
    expect(getLlmConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("respects the server's navigation permissions", () => {
    mount({ ...admin, navigation: { visiblePaths: ["/inbox"] } });
    expect(getLlmConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("removes stale model guidance when configuration access is denied", async () => {
    vi.mocked(getLlmConfig)
      .mockResolvedValueOnce({})
      .mockRejectedValue(new ApiError(403, "forbidden"));
    mount();
    await screen.findByText(/No model is configured/);
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    fireEvent.focus(window);
    expect(getLlmConfig).toHaveBeenCalledTimes(2);
  });

  it("does not turn a failed check into a missing-model warning or disclose its error", async () => {
    vi.mocked(getLlmConfig).mockRejectedValue(new Error("secret://private"));
    mount();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Model configuration could not be checked"
    );
    expect(document.body).not.toHaveTextContent("secret://private");
    expect(document.body).not.toHaveTextContent("No model is configured");
  });

  it("refreshes after focus and clears the warning when a model is added", async () => {
    vi.mocked(getLlmConfig).mockResolvedValueOnce({}).mockResolvedValue(configured);
    mount();
    await screen.findByText(/No model is configured/);
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("detects removal on a bounded refresh and stops polling after unmount", async () => {
    vi.useFakeTimers();
    vi.mocked(getLlmConfig).mockResolvedValueOnce(configured).mockResolvedValue({});
    const { unmount } = mount();
    await act(async () => {});
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("No model is configured");
    unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getLlmConfig).toHaveBeenCalledTimes(2);
  });
});
