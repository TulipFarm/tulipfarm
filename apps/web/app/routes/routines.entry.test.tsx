import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import RoutinesIndex from "./_app.routines._index";

vi.mock("@remix-run/react", async () => ({
  ...(await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react")),
  useLoaderData: vi.fn(),
}));

test("empty Routines offers a draft about the trigger, inputs and result", () => {
  vi.mocked(remix.useLoaderData).mockReturnValue({ routines: [], latest: {} });
  const Stub = createRemixStub([{ path: "/", Component: RoutinesIndex }]);
  render(<Stub />);
  const create = screen.getByRole("link", { name: "Create a routine in chat" });
  const draft = new URL(create.getAttribute("href") ?? "", "http://localhost").searchParams.get(
    "draft"
  );
  expect(draft).toMatch(/create a routine/i);
  expect(draft).toMatch(/start|trigger/i);
  expect(draft).toMatch(/inputs/);
  expect(draft).toMatch(/result/);
  expect(screen.getByRole("link", { name: "All runs" })).toHaveAttribute(
    "href",
    "/business/activities?source=run"
  );
  expect(document.querySelectorAll(".bg-primary")).toHaveLength(1);
});
