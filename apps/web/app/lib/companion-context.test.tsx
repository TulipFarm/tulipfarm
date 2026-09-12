import { Link, Outlet } from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { CompanionProvider, useCompanion } from "~/lib/companion-context";

vi.mock("~/lib/tasks", () => ({ listTasks: vi.fn(), dismissTask: vi.fn() }));

import { dismissTask, listTasks } from "~/lib/tasks";

function TaskCount() {
  const { tasks, error, refresh, dismiss } = useCompanion();
  return (
    <>
      <div data-testid="count">{tasks.length}</div>
      <p role="status">{error}</p>
      <button type="button" onClick={() => void refresh()}>
        Refresh
      </button>
      <button type="button" onClick={() => void dismiss("t1")}>
        Dismiss
      </button>
    </>
  );
}

/** The provider lives on the parent route, so it stays mounted across the navigation below — a
 * refetch after clicking can only come from the pathname effect, never from a remount. */
function renderApp(initialPath: string) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <CompanionProvider>
          <TaskCount />
          <Link to="/">chat</Link>
          <Outlet />
        </CompanionProvider>
      ),
      children: [
        { index: true, Component: () => <div>chat</div> },
        { path: "business/models", Component: () => <div>models</div> },
      ],
    },
  ]);
  return render(<Stub initialEntries={[initialPath]} />);
}

// A Task closes seconds after the action that satisfied it, so waiting for the 60s poll shows the
// user a demand to do something they just did. These pin the two refetches that close that window.
test("refetches when the user navigates, without remounting the provider", async () => {
  vi.mocked(listTasks).mockResolvedValue([{ id: "t1" }] as never);
  renderApp("/business/models");
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));

  vi.mocked(listTasks).mockResolvedValue([] as never);
  await userEvent.click(screen.getByRole("link", { name: "chat" }));
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));
});

test("refetches when the user comes back to the tab", async () => {
  vi.mocked(listTasks).mockResolvedValue([{ id: "t1" }] as never);
  renderApp("/");
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));

  vi.mocked(listTasks).mockResolvedValue([] as never);
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));
});

test("a failed refresh retains the last list and exposes a recoverable error", async () => {
  vi.mocked(listTasks).mockResolvedValue([{ id: "t1" }] as never);
  renderApp("/");
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));

  vi.mocked(listTasks).mockRejectedValue(new Error("offline"));
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn't load"));
  expect(screen.getByTestId("count")).toHaveTextContent("1");

  vi.mocked(listTasks).mockResolvedValue([]);
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.getByRole("status")).toBeEmptyDOMElement());
  expect(screen.getByTestId("count")).toHaveTextContent("0");
});

test("a failed dismissal leaves the task visible and reports the failure", async () => {
  vi.mocked(listTasks).mockResolvedValue([{ id: "t1" }] as never);
  vi.mocked(dismissTask).mockRejectedValue(new Error("offline"));
  renderApp("/");
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));

  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn't dismiss"));
  expect(screen.getByTestId("count")).toHaveTextContent("1");
});
