import { Link, Outlet } from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { CompanionProvider, useCompanion } from "~/lib/companion-context";

vi.mock("~/lib/tasks", () => ({ listTasks: vi.fn(), dismissTask: vi.fn() }));

import { listTasks } from "~/lib/tasks";

function TaskCount() {
  const { tasks } = useCompanion();
  return <div data-testid="count">{tasks.length}</div>;
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
