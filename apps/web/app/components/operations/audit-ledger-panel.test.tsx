import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLedgerPanel } from "~/components/operations/audit-ledger-panel";
import { type AuditEvent, listAuditEvents, verifyAuditChain } from "~/lib/audit";

vi.mock("~/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/audit")>();
  return { ...actual, listAuditEvents: vi.fn(), verifyAuditChain: vi.fn() };
});

const listMock = vi.mocked(listAuditEvents);
const verifyMock = vi.mocked(verifyAuditChain);

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "evt-1",
    chainIndex: 0,
    previousHash: null,
    hash: "abcdef0123456789abcdef",
    actorPrincipalId: "user-1",
    effectivePrincipalId: "user-1",
    action: "soul-config.git-remote",
    target: "soul:git-remote",
    decision: "allow",
    reasonCodes: ["SOUL_DIRECT_WRITE"],
    correlationId: "corr-1",
    occurredAt: "2024-05-01T10:00:00.000Z",
    agentId: null,
    runId: null,
    safeMetadata: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("AuditLedgerPanel", () => {
  it("renders ledger rows with their chain index and hash", async () => {
    listMock.mockResolvedValue({ items: [event()], nextCursor: null });
    verifyMock.mockResolvedValue({
      valid: true,
      eventCount: 1,
      tailHash: "abcdef0123456789abcdef",
      checkedAt: "2024-05-01T10:00:01.000Z",
      issues: [],
    });

    render(<AuditLedgerPanel />);

    expect(await screen.findByText("Soul config git remote")).toBeInTheDocument();
    expect(screen.getByText("SOUL_DIRECT_WRITE")).toBeInTheDocument();
    expect(screen.getByText("soul:git-remote")).toBeInTheDocument();
    // Truncated so a 64-char hash does not blow out the row, but present so an operator can
    // compare it against an externally pinned value.
    expect(screen.getByText("abcdef012345")).toBeInTheDocument();
  });

  it("surfaces a broken chain instead of rendering the rows as if they were trustworthy", async () => {
    listMock.mockResolvedValue({ items: [event()], nextCursor: null });
    verifyMock.mockResolvedValue({
      valid: false,
      eventCount: 3,
      tailHash: "deadbeef",
      checkedAt: "2024-05-01T10:00:01.000Z",
      issues: [{ type: "tampered", chainIndex: 1, eventIds: ["evt-2"] }],
    });

    render(<AuditLedgerPanel />);

    expect(await screen.findByText(/Chain BROKEN/)).toBeInTheDocument();
  });

  it("pages with the cursor rather than refetching from the start", async () => {
    listMock
      .mockResolvedValueOnce({ items: [event()], nextCursor: 5 })
      .mockResolvedValueOnce({ items: [event({ id: "evt-2", chainIndex: 4 })], nextCursor: null });
    verifyMock.mockResolvedValue({
      valid: true,
      eventCount: 2,
      tailHash: "abc",
      checkedAt: "2024-05-01T10:00:01.000Z",
      issues: [],
    });

    render(<AuditLedgerPanel />);
    await screen.findByRole("table", { name: "Audit ledger" });

    await userEvent.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(listMock).toHaveBeenLastCalledWith(5, 25);
    // Appended, not replaced: a reader scrolling back through the ledger must not lose the rows
    // already on screen.
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("reports a failed load instead of showing an empty ledger", async () => {
    // An unreadable ledger and an empty one look identical to an operator, and only one of them
    // is fine.
    listMock.mockRejectedValue(new Error("forbidden"));
    verifyMock.mockRejectedValue(new Error("forbidden"));

    render(<AuditLedgerPanel />);

    expect(await screen.findByText("forbidden")).toBeInTheDocument();
    expect(screen.queryByText("No audit events recorded")).not.toBeInTheDocument();
  });
});
