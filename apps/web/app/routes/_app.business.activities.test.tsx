import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { beforeEach, expect, test, vi } from "vitest";
import type { ActivityItem } from "~/lib/activities";
import type { OperationalRun } from "~/lib/operations";

vi.mock("~/lib/activities", () => ({ listActivities: vi.fn() }));
vi.mock("~/lib/operations", () => ({ listOperationalRuns: vi.fn() }));
vi.mock("~/lib/use-session-user", () => ({ useSessionUser: vi.fn() }));

const { listActivities } = await import("~/lib/activities");
const { listOperationalRuns } = await import("~/lib/operations");
const { useSessionUser } = await import("~/lib/use-session-user");
const Activities = (await import("./_app.business.activities")).default;

const listActivitiesMock = vi.mocked(listActivities);
const listRunsMock = vi.mocked(listOperationalRuns);
const sessionMock = vi.mocked(useSessionUser);

function log(id: string, at: string, extra: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id,
    category: "resource",
    action: "resource.created",
    actorType: "user",
    actorId: "priya.raman",
    targetType: "resource",
    targetId: "ticket-4821",
    summary: `Created Ticket ${id}`,
    status: "ok",
    metadata: {},
    createdAt: at,
    ...extra,
  };
}

function run(id: string, at: string, status = "succeeded"): OperationalRun {
  return {
    id,
    routineId: "nightly-sweep",
    routineVersion: "1",
    status,
    version: 1,
    createdAt: at,
    startedAt: at,
    finishedAt: null,
    states: [],
    effects: [],
    waits: [],
    guardrailDecisions: [],
    lineage: [],
    costs: { amountUsd: 0, modelTokens: 0 },
  };
}

function signedIn(canReadRuns: boolean): void {
  sessionMock.mockReturnValue({
    id: "u1",
    email: "priya.raman@example.com",
    name: "Priya Raman",
    role: "member",
    navigation: {
      visiblePaths: canReadRuns ? ["/runs", "/business/activities"] : ["/business/activities"],
    },
    // biome-ignore lint/suspicious/noExplicitAny: the route reads two fields of a wide session shape.
  } as any);
}

/*
 * The Remix stub supplies router context for the Run links; the search params come from nuqs's
 * own testing adapter, because the Remix adapter reads the real window location, which a memory
 * router never touches.
 */
function renderAt(search: string) {
  const urls: string[] = [];
  const Stub = createRemixStub([
    {
      path: "/business/activities",
      Component: () => (
        <NuqsTestingAdapter
          searchParams={search}
          onUrlUpdate={(update) => urls.push(update.queryString)}
        >
          <Activities />
        </NuqsTestingAdapter>
      ),
    },
    { path: "/runs/:id", Component: () => <p>run inspector</p> },
  ]);
  render(<Stub initialEntries={["/business/activities"]} />);
  return { urls };
}

beforeEach(() => {
  vi.clearAllMocks();
  listActivitiesMock.mockResolvedValue({ items: [], nextCursor: null });
  listRunsMock.mockResolvedValue({ items: [], nextCursor: null });
  signedIn(true);
});

test("interleaves Runs and log entries into one newest-first timeline", async () => {
  listActivitiesMock.mockResolvedValue({
    items: [log("a", "2026-08-27T12:00:00Z"), log("b", "2026-08-27T08:00:00Z")],
    nextCursor: null,
  });
  listRunsMock.mockResolvedValue({
    items: [run("r1", "2026-08-27T10:00:00Z")],
    nextCursor: null,
  });

  renderAt("?range=all");

  const rows = await screen.findAllByRole("listitem");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent("Created Ticket a");
  expect(rows[1]).toHaveTextContent("Nightly sweep run");
  expect(rows[2]).toHaveTextContent("Created Ticket b");
});

test("says one word for success and keeps the Run id out of the row", async () => {
  listActivitiesMock.mockResolvedValue({
    items: [log("a", "2026-08-27T12:00:00Z")],
    nextCursor: null,
  });
  listRunsMock.mockResolvedValue({
    items: [run("6b1f5c9e-run-uuid", "2026-08-27T10:00:00Z")],
    nextCursor: null,
  });

  renderAt("?range=all");

  const rows = await screen.findAllByRole("listitem");
  // The log calls it "ok" and a Run calls it "succeeded"; adjacent rows must not use both.
  expect(rows[0]).toHaveTextContent("succeeded");
  expect(rows[0]).not.toHaveTextContent("ok");
  expect(rows[1]).toHaveTextContent("succeeded");
  // A bare uuid is noise in a list, and the row already links to the inspector that owns it.
  expect(rows[1]).not.toHaveTextContent("6b1f5c9e-run-uuid");
  expect(rows[1]).toHaveTextContent("1");
});

test("a Run row links to its own inspector", async () => {
  listRunsMock.mockResolvedValue({ items: [run("r 1", "2026-08-27T10:00:00Z")], nextCursor: null });

  renderAt("?range=all");

  const link = await screen.findByRole("link", { name: /Nightly sweep run/ });
  expect(link).toHaveAttribute("href", "/runs/r%201");
});

test("never reads the Runs feed for a session that cannot see it", async () => {
  signedIn(false);
  listActivitiesMock.mockResolvedValue({
    items: [log("a", "2026-08-27T12:00:00Z")],
    nextCursor: null,
  });

  renderAt("?range=all&source=run");

  await screen.findByText("Created Ticket a");
  expect(listRunsMock).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Runs" })).not.toBeInTheDocument();
});

test("the URL drives the query, so a filtered view is a shareable link", async () => {
  renderAt("?source=resource&range=1h&problems=true&size=100");

  await waitFor(() => expect(listActivitiesMock).toHaveBeenCalled());
  expect(listActivitiesMock.mock.calls[0][0]).toMatchObject({ limit: 100 });
  expect(listRunsMock).not.toHaveBeenCalled();
  expect(screen.getByRole("radio", { name: "Records" })).toBeChecked();
  expect(screen.getByLabelText("Time range")).toHaveValue("1h");
  expect(screen.getByLabelText("Problems only")).toBeChecked();
});

test("?event= opens the entry it names, so a link to one event survives a reload", async () => {
  listActivitiesMock.mockResolvedValue({
    items: [log("a", "2026-08-27T12:00:00Z", { metadata: { ticket: "4821" } })],
    nextCursor: null,
  });

  renderAt("?range=all&event=log:a");

  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByText("resource.created")).toBeInTheDocument();
  expect(within(sheet).getByText(/"ticket": "4821"/)).toBeInTheDocument();
});

test("says so when a deep link names an entry outside the current view", async () => {
  renderAt("?event=log:gone");

  expect(await screen.findByText(/not in this view/)).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("names the range in the empty state and offers a way back to the default view", async () => {
  const user = userEvent.setup();
  const { urls } = renderAt("?range=1h&problems=true");

  expect(await screen.findByText(/Nothing went wrong in the past hour/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Clear the filters" }));

  // Resetting drops the params rather than restating the defaults, so the shared link stays short.
  await waitFor(() => expect(urls.at(-1)).toBe(""));
});

test("offers a retry rather than an empty page when the feed cannot be read", async () => {
  const user = userEvent.setup();
  listActivitiesMock.mockRejectedValueOnce(new Error("Network request failed"));

  renderAt("?range=all");

  expect(await screen.findByText("Network request failed")).toBeInTheDocument();
  listActivitiesMock.mockResolvedValue({
    items: [log("a", "2026-08-27T12:00:00Z")],
    nextCursor: null,
  });
  await user.click(screen.getByRole("button", { name: "Try again" }));

  expect(await screen.findByText("Created Ticket a")).toBeInTheDocument();
});

test("offers to keep reading rather than claiming nothing went wrong on a spent budget", async () => {
  // Every page is healthy, so a failures-only pull spends its whole network budget finding none.
  listActivitiesMock.mockImplementation(async (options = {}) => {
    const index = options.cursor === undefined ? 0 : Number(options.cursor);
    return {
      items: [log(`ok${index}`, new Date(Date.UTC(2026, 7, 27, 12, 0, 30 - index)).toISOString())],
      nextCursor: String(index + 1),
    };
  });

  renderAt("?range=all&source=resource&problems=true");

  expect(await screen.findByText(/No matches in the stretch read so far/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Keep reading" })).toBeInTheDocument();
  expect(screen.queryByText(/Nothing went wrong/)).not.toBeInTheDocument();
});

test("still honours the retired ?category= links the previous page handed out", async () => {
  renderAt("?category=job&range=all");

  await waitFor(() => expect(listActivitiesMock).toHaveBeenCalled());
  expect(listActivitiesMock.mock.calls[0][0]).toMatchObject({ category: "job" });
  expect(listRunsMock).not.toHaveBeenCalled();
});

test("appends the next page instead of re-reading from the top", async () => {
  const user = userEvent.setup();
  const first = Array.from({ length: 25 }, (_, i) =>
    log(`a${i}`, new Date(Date.UTC(2026, 7, 27, 12, 0, 25 - i)).toISOString())
  );
  listActivitiesMock.mockImplementation(async (options = {}) =>
    options.cursor === undefined
      ? { items: first, nextCursor: "1" }
      : { items: [log("older", "2026-08-26T08:00:00Z")], nextCursor: null }
  );

  renderAt("?range=all&source=resource&size=25");

  expect(await screen.findByText("25 events")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Load 25 more/ }));

  expect(await screen.findByText("26 events")).toBeInTheDocument();
  expect(screen.getByText("Created Ticket a0")).toBeInTheDocument();
  expect(screen.getByText("Nothing older in this range.")).toBeInTheDocument();
});
