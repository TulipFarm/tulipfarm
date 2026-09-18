import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpAccountSummary, McpKnowledgeStatus } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import {
  getMcpKnowledge,
  removeMcpKnowledge,
  saveMcpKnowledge,
  syncMcpKnowledge,
} from "~/lib/mcp-knowledge";
import { McpKnowledge } from "./mcp-knowledge";

vi.mock("~/lib/mcp-knowledge", () => ({
  getMcpKnowledge: vi.fn(),
  removeMcpKnowledge: vi.fn(),
  saveMcpKnowledge: vi.fn(),
  syncMcpKnowledge: vi.fn(),
}));

const account: McpAccountSummary = {
  id: "personal-account",
  integrationKey: "github-mcp",
  businessId: "business",
  definitionDigest: "a".repeat(64),
  label: "My GitHub",
  owner: { scope: "personal", principalId: "user" },
  authentication: "token",
  status: "active",
  isDefault: false,
  revision: 1,
  expiresAt: null,
  createdAt: "2026-09-18T00:00:00Z",
  updatedAt: "2026-09-18T00:00:00Z",
};
const source = { owner: "example", repo: "handbook", path: "README.md", ref: "refs/heads/main" };
const eligible: McpKnowledgeStatus = {
  eligibility: { supported: true, reason: null, sourceKind: "github-file", visibility: "personal" },
  selection: null,
};
const configured: McpKnowledgeStatus = {
  ...eligible,
  selection: {
    id: "selection",
    revision: 3,
    enabled: true,
    files: [source],
    pollIntervalMs: 900_000,
    progress: {
      selectionRevision: "3",
      nextIndex: 0,
      synced: 0,
      failed: 0,
      complete: false,
      failures: [],
      updatedAt: account.updatedAt,
    },
    lastAttemptAt: null,
    lastCompletedAt: null,
    nextAttemptAt: account.updatedAt,
    errorCode: null,
    cleanupPending: 0,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMcpKnowledge).mockResolvedValue(eligible);
});

function mount() {
  const Stub = createRemixStub([
    { path: "/", Component: () => <McpKnowledge account={account} /> },
  ]);
  render(<Stub />);
}

test("saves explicit source files for the exact account without inventing a provider inventory", async () => {
  vi.mocked(saveMcpKnowledge).mockResolvedValue(configured);
  mount();
  await userEvent.type(await screen.findByLabelText("Repository owner"), source.owner);
  await userEvent.type(screen.getByLabelText("Repository", { exact: true }), source.repo);
  await userEvent.type(screen.getByLabelText("File path"), source.path);
  await userEvent.type(screen.getByLabelText("Branch reference"), source.ref);
  await userEvent.click(screen.getByRole("button", { name: "Save Knowledge sources" }));
  expect(saveMcpKnowledge).toHaveBeenCalledWith("github-mcp", "personal-account", {
    enabled: true,
    files: [source],
    pollIntervalMs: 900_000,
  });
  expect(await screen.findByRole("region", { name: "Knowledge sync progress" })).toHaveTextContent(
    "Current pass incomplete"
  );
  expect(syncMcpKnowledge).not.toHaveBeenCalled();
});

test("unsupported server metadata never exposes source-writing controls", async () => {
  vi.mocked(getMcpKnowledge).mockResolvedValue({
    ...eligible,
    eligibility: { ...eligible.eligibility, supported: false, reason: "unsupported_shared_sync" },
  });
  mount();
  expect(await screen.findByText(/Shared Knowledge sync is not supported/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save Knowledge sources" })).not.toBeInTheDocument();
  expect(saveMcpKnowledge).not.toHaveBeenCalled();
});

test("sync and confirmed removal bind the current selection revision and show real cleanup status", async () => {
  vi.mocked(getMcpKnowledge).mockResolvedValue(configured);
  vi.mocked(syncMcpKnowledge).mockResolvedValue(configured);
  if (!configured.selection) throw new Error("Expected configured selection.");
  vi.mocked(removeMcpKnowledge).mockResolvedValue({
    ...configured,
    selection: { ...configured.selection, enabled: false, cleanupPending: 1 },
  });
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  expect(syncMcpKnowledge).toHaveBeenCalledWith("github-mcp", "personal-account", 3);
  expect(screen.getByRole("region", { name: "Knowledge sync progress" })).toHaveTextContent(
    "Current pass incomplete"
  );
  await userEvent.click(screen.getByRole("button", { name: "Remove Knowledge sources" }));
  expect(removeMcpKnowledge).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Confirm remove Knowledge sources" }));
  expect(removeMcpKnowledge).toHaveBeenCalledWith("github-mcp", "personal-account", 3);
  expect(await screen.findByText(/1 copied Pages await cleanup/)).toBeInTheDocument();
});

test("concurrent source edits retain the draft and offer explicit reload recovery", async () => {
  vi.mocked(getMcpKnowledge).mockResolvedValue(configured);
  vi.mocked(saveMcpKnowledge).mockRejectedValue(
    new ApiError(409, "Conflict", undefined, "conflict")
  );
  mount();
  await userEvent.type(await screen.findByLabelText("File path"), ".txt");
  await userEvent.click(screen.getByRole("button", { name: "Save Knowledge sources" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("changed while you were editing");
  expect(screen.getByRole("button", { name: "Discard changes and reload" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
});
