import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { getTeamMigrationReport } from "~/lib/admin";
import { ApiError } from "~/lib/api";
import TeamMigrationReport, {
  clientLoader,
  ErrorBoundary,
} from "./_app.business.access.teams_.migration-report";

vi.mock("~/lib/admin", async () => ({
  ...(await vi.importActual<typeof import("~/lib/admin")>("~/lib/admin")),
  getTeamMigrationReport: vi.fn(),
}));

function renderRoute() {
  const Stub = createRemixStub([
    {
      path: "/business/access/teams/migration-report",
      Component: TeamMigrationReport,
      loader: clientLoader,
      ErrorBoundary,
    },
  ]);
  return render(<Stub initialEntries={["/business/access/teams/migration-report"]} />);
}

afterEach(() => vi.clearAllMocks());

test("shows each migration conflict type and handles an unknown conflict defensively", async () => {
  vi.mocked(getTeamMigrationReport).mockResolvedValue({
    items: [
      {
        legacyGroupId: "Customer Success",
        teamId: "10000000-0000-4000-8000-000000000002",
        teamSlug: "customer-success-2",
        displayName: "Customer Success (2)",
        slugConflict: true,
        siblingNameConflict: true,
        migratedAt: "2026-09-05T00:00:00.000Z",
      },
      {
        legacyGroupId: "Billing/Ops",
        teamId: "10000000-0000-4000-8000-000000000003",
        teamSlug: "billing-ops-a1b2c3d4",
        displayName: "Billing/Ops",
        slugConflict: true,
        siblingNameConflict: false,
        migratedAt: "2026-09-05T00:00:00.000Z",
      },
      {
        legacyGroupId: "Support Ops",
        teamId: "10000000-0000-4000-8000-000000000004",
        teamSlug: "support-ops-2",
        displayName: "Support Ops [a1b2c3d4]",
        slugConflict: false,
        siblingNameConflict: true,
        migratedAt: "2026-09-05T00:00:00.000Z",
      },
      {
        legacyGroupId: "Clean migration",
        teamId: "10000000-0000-4000-8000-000000000005",
        teamSlug: "clean-migration",
        displayName: "Clean migration",
        slugConflict: false,
        siblingNameConflict: false,
        migratedAt: "2026-09-05T00:00:00.000Z",
      },
    ],
  });

  renderRoute();

  const row = await screen.findByRole("row", { name: /Customer Success/ });
  expect(within(row).getByText("Slug and sibling name")).toBeInTheDocument();
  expect(within(row).getByText("Customer Success", { exact: true })).toBeInTheDocument();
  expect(within(row).getByText("Customer Success (2)")).toBeInTheDocument();
  expect(within(row).getByText("customer-success-2")).toBeInTheDocument();
  expect(within(row).getByText("Resolved")).toBeInTheDocument();
  expect(within(row).getByText(/^Migrated /)).toBeInTheDocument();
  expect(within(row).getByRole("link", { name: "Review Team" })).toHaveAttribute(
    "href",
    "/teams/customer-success-2"
  );

  const slugRow = screen.getByRole("row", { name: /Billing\/Ops/ });
  expect(within(slugRow).getByText("Slug", { exact: true })).toBeInTheDocument();

  const siblingRow = screen.getByRole("row", { name: /Support Ops/ });
  expect(within(siblingRow).getByText("Sibling name", { exact: true })).toBeInTheDocument();

  const unknownRow = screen.getByRole("row", { name: /Clean migration/ });
  expect(within(unknownRow).getByText("Unknown conflict")).toBeInTheDocument();
  expect(within(unknownRow).queryByText("Sibling name")).not.toBeInTheDocument();
});

test("shows the clear empty state when migration had no conflicts", async () => {
  vi.mocked(getTeamMigrationReport).mockResolvedValue({ items: [] });

  renderRoute();

  expect(await screen.findByText("No Team migration conflicts")).toBeInTheDocument();
});

test.each([
  [new ApiError(403, "forbidden"), "Only a company admin can view the Team migration report."],
  [new ApiError(503, "Service unavailable"), "Service unavailable"],
])("shows an actionable error state for %s", async (error, message) => {
  vi.mocked(getTeamMigrationReport).mockRejectedValue(error);

  renderRoute();

  expect(await screen.findByRole("alert")).toHaveTextContent(message);
});
