import { useLocation } from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PACK_MAX_BYTES, PACK_READ_MAX_RESULT_CHARS } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { chatLaunchFromState } from "~/lib/chat/launch";
import {
  listPacks,
  type PackPreview,
  packPlanPrompt,
  packPreviewLaunchError,
  previewPack,
} from "~/lib/packs";
import PacksCatalog from "./_app.packs._index";
import ImportPack from "./_app.packs.import";

vi.mock("~/lib/packs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/packs")>()),
  listPacks: vi.fn(),
  previewPack: vi.fn(),
}));

const preview: PackPreview = {
  sha256: "a".repeat(64),
  url: "https://example.com/sales.yaml",
  pack: {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Pack",
    name: "sales",
    title: "Sales essentials",
    description: "Track customers and follow up.",
    category: "Sales",
    version: 1,
    requirements: ["A connected email Integration"],
    artifacts: [
      {
        kind: "resource",
        name: "customer",
        description: "Customer contact details",
        template: { type: "object", properties: { email: { type: "string" } } },
      },
    ],
    plan: {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Plan",
      name: "sales",
      version: 1,
      steps: [{ id: "inspect", tool: "resource_list" }],
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPacks).mockResolvedValue([
    { ...preview.pack, url: "https://example.com/sales.yaml" },
    {
      ...preview.pack,
      name: "support",
      title: "Support essentials",
      description: "Resolve incoming tickets.",
      category: "Support",
      url: "https://example.com/support.yaml",
    },
  ]);
  vi.mocked(previewPack).mockResolvedValue(preview);
});

function ChatDestination() {
  const location = useLocation();
  const launch = chatLaunchFromState(location.state);
  return (
    <>
      <p>Chat mode: {launch?.mode}</p>
      <pre data-testid="prompt">{launch?.prompt}</pre>
      <p data-testid="query">{location.search}</p>
    </>
  );
}

function renderPage(path = "/packs") {
  const Stub = createRemixStub([
    { path: "/packs", Component: PacksCatalog },
    { path: "/packs/import", Component: ImportPack },
    { path: "/", Component: ChatDestination },
  ]);
  return render(<Stub initialEntries={[path]} />);
}

test("catalog filters by category and search, with a no-match state", async () => {
  const user = userEvent.setup();
  renderPage();
  expect(await screen.findByText("Sales essentials")).toBeInTheDocument();
  expect(screen.getByText("Support essentials")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Sales" }));
  expect(screen.queryByText("Support essentials")).not.toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "Search Packs" }), "unknown");
  expect(screen.getByText(/No Packs match/)).toBeInTheDocument();
  await user.clear(screen.getByRole("textbox", { name: "Search Packs" }));
  await user.click(screen.getByRole("button", { name: "All" }));
  await user.type(screen.getByRole("textbox", { name: "Search Packs" }), "tickets");
  expect(screen.getByText("Support essentials")).toBeInTheDocument();
  expect(screen.queryByText("Sales essentials")).not.toBeInTheDocument();
});

test("catalog loading, error retry and empty states are distinct", async () => {
  vi.mocked(listPacks).mockReturnValueOnce(new Promise(() => {}));
  const mounted = renderPage();
  expect(await screen.findByRole("status")).toHaveTextContent("Loading Packs");
  mounted.unmount();
  vi.mocked(listPacks).mockRejectedValueOnce(new ApiError(503, "unavailable"));
  renderPage();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load Packs");
  vi.mocked(listPacks).mockResolvedValueOnce([]);
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText(/No Packs are available yet/)).toBeInTheDocument();
});

test("preview is read-only, displays assets and trust facts, then launches a pinned Plan-mode Chat", async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(
    await screen.findByRole("button", { name: "Preview installation of Sales essentials" })
  );
  expect(await screen.findByText("Customer contact details")).toBeInTheDocument();
  expect(previewPack).toHaveBeenCalledWith({ url: "https://example.com/sales.yaml" });
  expect(screen.getByText("A connected email Integration")).toBeInTheDocument();
  expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
  expect(screen.getByText(/Validation checks the Pack format/)).toHaveTextContent(
    "Nothing is installed here"
  );
  expect(screen.queryByText("Chat mode: plan")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Prepare plan in Chat" }));
  expect(await screen.findByText("Chat mode: plan")).toBeInTheDocument();
  const prompt = screen.getByTestId("prompt").textContent;
  expect(prompt).toContain("pack_read");
  expect(prompt).toContain(preview.sha256);
  expect(prompt).toContain(JSON.stringify({ url: preview.url, expectedSha256: preview.sha256 }));
  expect(prompt).not.toContain(JSON.stringify(preview.pack));
  expect(prompt).toContain("until I explicitly confirm");
  expect(screen.getByTestId("query")).toBeEmptyDOMElement();
});

test("catalog preview failures can be retried without implying installation", async () => {
  vi.mocked(previewPack).mockRejectedValueOnce(new ApiError(422, "invalid"));
  renderPage();
  await userEvent.click(
    await screen.findByRole("button", { name: "Preview installation of Sales essentials" })
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not preview");
  expect(screen.queryByRole("button", { name: "Prepare plan in Chat" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry preview" }));
  expect(await screen.findByRole("button", { name: "Prepare plan in Chat" })).toBeInTheDocument();
});

test("import rejects non-HTTPS and credential URLs without an API request", async () => {
  renderPage("/packs/import");
  for (const url of [
    "http://example.com/pack.yaml",
    "https://user:password@example.com/pack.yaml",
  ]) {
    fireEvent.change(screen.getByLabelText("Pack URL"), { target: { value: url } });
    await userEvent.click(screen.getByRole("button", { name: "Preview installation" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an HTTPS Pack URL");
  }
  expect(previewPack).not.toHaveBeenCalled();
});

test("import URL validates through the API and editing it invalidates the preview", async () => {
  const user = userEvent.setup();
  renderPage("/packs/import");
  await user.type(screen.getByLabelText("Pack URL"), "https://example.com/sales.yaml");
  await user.click(screen.getByRole("button", { name: "Preview installation" }));
  expect(await screen.findByRole("region", { name: "Pack preview" })).toBeInTheDocument();
  expect(previewPack).toHaveBeenCalledWith({ url: "https://example.com/sales.yaml" });
  await user.type(screen.getByLabelText("Pack URL"), "?changed");
  expect(screen.queryByRole("region", { name: "Pack preview" })).not.toBeInTheDocument();
});

test("pasted YAML reaches Chat completely, not via the URL, and cannot double-submit", async () => {
  const source = `# ${"original source ".repeat(5000)}\napiVersion: tulipfarm.ai/v1\nkind: Pack\n# END OF SOURCE`;
  let completePreview: ((value: PackPreview) => void) | undefined;
  vi.mocked(previewPack).mockImplementation(
    () =>
      new Promise((resolve) => {
        completePreview = resolve;
      })
  );
  renderPage("/packs/import");
  await userEvent.click(screen.getByRole("button", { name: "Paste YAML" }));
  fireEvent.change(screen.getByLabelText("Pack YAML"), { target: { value: source } });
  await userEvent.dblClick(screen.getByRole("button", { name: "Preview installation" }));
  await waitFor(() => expect(previewPack).toHaveBeenCalledWith({ yaml: source }));
  expect(previewPack).toHaveBeenCalledTimes(1);
  completePreview?.({ ...preview, url: undefined });
  expect(await screen.findByText("Pasted YAML")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Prepare plan in Chat" }));
  expect(await screen.findByText("Chat mode: plan")).toBeInTheDocument();
  expect(screen.getByTestId("prompt").textContent).toContain(source);
  expect(screen.getByTestId("query")).toBeEmptyDOMElement();
});

test("import handles permission failures and keeps invalid content available to correct", async () => {
  vi.mocked(previewPack).mockRejectedValueOnce(new ApiError(403, "forbidden", "/yaml"));
  renderPage("/packs/import");
  await userEvent.click(screen.getByRole("button", { name: "Paste YAML" }));
  fireEvent.change(screen.getByLabelText("Pack YAML"), { target: { value: "kind: Invalid" } });
  await userEvent.click(screen.getByRole("button", { name: "Preview installation" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("permission");
  expect(screen.getByLabelText("Pack YAML")).toHaveValue("kind: Invalid");
  expect(screen.getByLabelText("Pack YAML")).toHaveAttribute("aria-invalid", "true");
  expect(screen.queryByRole("button", { name: "Prepare plan in Chat" })).not.toBeInTheDocument();
});

test("pasted YAML plus planning instructions at the complete-message byte limit is handed over intact", async () => {
  const pasted = { ...preview, url: undefined };
  const overhead = new TextEncoder().encode(packPlanPrompt(pasted, { yaml: "" })).byteLength;
  const yaml = `#${"x".repeat(PACK_MAX_BYTES - overhead - 1)}`;
  const prompt = packPlanPrompt(pasted, { yaml });
  expect(new TextEncoder().encode(prompt).byteLength).toBe(PACK_MAX_BYTES);
  vi.mocked(previewPack).mockResolvedValue(pasted);
  renderPage("/packs/import");
  await userEvent.click(screen.getByRole("button", { name: "Paste YAML" }));
  fireEvent.change(screen.getByLabelText("Pack YAML"), { target: { value: yaml } });
  await userEvent.click(screen.getByRole("button", { name: "Preview installation" }));
  await userEvent.click(await screen.findByRole("button", { name: "Prepare plan in Chat" }));
  expect(await screen.findByText("Chat mode: plan")).toBeInTheDocument();
  expect(screen.getByTestId("prompt").textContent).toBe(prompt);
});

test("an oversized complete YAML handoff is explicitly blocked, preserving the original source", async () => {
  const pasted = { ...preview, url: undefined };
  const overhead = new TextEncoder().encode(packPlanPrompt(pasted, { yaml: "" })).byteLength;
  const yaml = `#${"x".repeat(PACK_MAX_BYTES - overhead)}`;
  vi.mocked(previewPack).mockResolvedValue(pasted);
  renderPage("/packs/import");
  await userEvent.click(screen.getByRole("button", { name: "Paste YAML" }));
  fireEvent.change(screen.getByLabelText("Pack YAML"), { target: { value: yaml } });
  await userEvent.click(screen.getByRole("button", { name: "Preview installation" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Nothing has been sent or omitted");
  expect(screen.getByRole("button", { name: "Prepare plan in Chat" })).toBeDisabled();
  expect(screen.getByLabelText("Pack YAML")).toHaveValue(yaml);
  expect(screen.queryByText("Chat mode: plan")).not.toBeInTheDocument();
});

test("URL handoff stays short even when the preview contains a large template", async () => {
  const large = {
    ...preview,
    pack: {
      ...preview.pack,
      artifacts: preview.pack.artifacts.map((artifact) => ({
        ...artifact,
        template: { full: "x".repeat(PACK_MAX_BYTES) },
      })),
    },
  };
  const prompt = packPlanPrompt(large, { url: "https://example.com/sales.yaml" });
  expect(new TextEncoder().encode(prompt).byteLength).toBeLessThan(4_000);
  expect(prompt).toContain(`"expectedSha256":"${preview.sha256}"`);
  expect(prompt).toContain("fresh preview and confirmation");
  expect(prompt).not.toContain("x".repeat(100));
});

test("a preview beyond the complete Tool-result limit is blocked before launching Chat", async () => {
  const withPadding = (padding: string): PackPreview => ({
    ...preview,
    pack: {
      ...preview.pack,
      artifacts: preview.pack.artifacts.map((artifact) => ({
        ...artifact,
        template: { padding },
      })),
    },
  });
  const overhead = JSON.stringify(withPadding("")).length;
  const boundary = withPadding("x".repeat(PACK_READ_MAX_RESULT_CHARS - overhead));
  expect(packPreviewLaunchError(boundary)).toBeNull();
  const oversized = withPadding("x".repeat(PACK_READ_MAX_RESULT_CHARS - overhead + 1));
  expect(packPreviewLaunchError(oversized)).toContain("38,000-character");
  vi.mocked(previewPack).mockResolvedValue(oversized);
  renderPage("/packs/import");
  fireEvent.change(screen.getByLabelText("Pack URL"), { target: { value: preview.url } });
  await userEvent.click(screen.getByRole("button", { name: "Preview installation" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Use a smaller Pack");
  expect(screen.getByRole("button", { name: "Prepare plan in Chat" })).toBeDisabled();
  expect(screen.getByRole("region", { name: "Pack preview" })).toBeInTheDocument();
});
