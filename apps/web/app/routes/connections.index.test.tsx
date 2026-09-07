import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import ChooseAdhocConnection from "./_app.business.connections._index";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn() };
});

afterEach(() => vi.clearAllMocks());

function renderRoute() {
  vi.mocked(remix.useLoaderData).mockReturnValue({
    origin: "https://api.example.com",
    host: "api.example.com",
    returnTo: "/chat/conversation-1",
    candidates: [
      {
        connectionId: "personal-id",
        label: "My API",
        ownerScope: "personal",
      },
      {
        connectionId: "business-id",
        label: "Shared API",
        ownerScope: "organization",
      },
    ],
  });
  const Stub = createRemixStub([{ path: "/", Component: ChooseAdhocConnection }]);
  render(<Stub initialEntries={["/"]} />);
}

test("lists only the API-provided scoped choices and returns to the originating Chat", async () => {
  renderRoute();

  expect(screen.getByText("Personal")).toBeInTheDocument();
  expect(screen.getByText("Business")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: /Shared APIBusiness/ }));
  await userEvent.click(screen.getByRole("button", { name: "Use this Connection" }));

  expect(screen.getByText(/connection_id="business-id"/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Return to Chat" })).toHaveAttribute(
    "href",
    "/chat/conversation-1"
  );
});
