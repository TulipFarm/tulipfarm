import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { getCustomInstructions, putCustomInstructions } from "~/lib/settings";
import SettingsInstructions, { clientLoader } from "./_app.settings.instructions";

vi.mock("~/lib/settings", async () => {
  const actual = await vi.importActual<typeof import("~/lib/settings")>("~/lib/settings");
  return {
    ...actual,
    getCustomInstructions: vi.fn(),
    putCustomInstructions: vi.fn(),
  };
});

const mockGet = vi.mocked(getCustomInstructions);
const mockPut = vi.mocked(putCustomInstructions);

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue("Answer in plain language.");
  mockPut.mockResolvedValue(undefined as never);
});

function renderPage() {
  const Stub = createRemixStub([
    { path: "/", Component: SettingsInstructions, loader: clientLoader },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

test("shows the saved instructions", async () => {
  renderPage();
  expect(await screen.findByLabelText("Custom instructions")).toHaveValue(
    "Answer in plain language."
  );
});

test("saves an edit", async () => {
  renderPage();
  const box = await screen.findByLabelText("Custom instructions");
  await userEvent.clear(box);
  await userEvent.type(box, "Be terse.");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mockPut).toHaveBeenCalledWith("Be terse."));
});

/**
 * The regression this exists for: Memory is one Markdown document the system maintains, and this
 * page used to let a user approve suggestions and edit individual facts. Re-adding either would
 * put a key-value store back in front of a user who no longer has one.
 */
test("offers no memory list, suggestion queue, or per-fact editing", async () => {
  renderPage();
  await screen.findByLabelText("Custom instructions");

  expect(screen.queryByText(/suggested memories/i)).toBeNull();
  expect(screen.queryByText(/saved memories/i)).toBeNull();
  expect(screen.queryByRole("button", { name: /keep|discard|forget/i })).toBeNull();
  expect(screen.queryByPlaceholderText(/what should the assistant remember/i)).toBeNull();
});

test("survives a deployment that serves no instructions yet", async () => {
  mockGet.mockRejectedValue(new Error("not found"));
  renderPage();
  expect(await screen.findByLabelText("Custom instructions")).toHaveValue("");
});
