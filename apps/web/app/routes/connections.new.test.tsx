import type { ClientLoaderFunctionArgs } from "@remix-run/react";
import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import * as connections from "~/lib/connections";
import NewAdhocConnection, { clientLoader } from "./_app.business.connections.new";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
  };
});

vi.mock("~/lib/connections", async () => {
  const actual = await vi.importActual<typeof import("~/lib/connections")>("~/lib/connections");
  return {
    ...actual,
    createAdhocConnection: vi.fn(),
    getAdhocConnection: vi.fn(),
  };
});

vi.mock("~/lib/use-session-user", () => ({
  useIsAdmin: () => true,
}));

afterEach(() => vi.clearAllMocks());

function load() {
  vi.mocked(remix.useLoaderData).mockReturnValue({
    origin: "https://api.example.com",
    host: "api.example.com",
    returnTo: "/chat/conversation-1",
    existing: { origin: "https://api.example.com", state: "none" },
  });
}

function renderRoute() {
  const Stub = createRemixStub([{ path: "/", Component: NewAdhocConnection }]);
  render(<Stub initialEntries={["/"]} />);
}

test("keeps the credential in the trusted form and posts the narrow personal scope", async () => {
  load();
  vi.mocked(connections.createAdhocConnection).mockResolvedValue({
    connectionId: "c1",
    origin: "https://api.example.com",
    scope: "personal",
  });
  renderRoute();

  const secret = screen.getByLabelText(/^Credential value/);
  expect(secret).toHaveAttribute("type", "password");
  expect(secret).toHaveAttribute("autocomplete", "off");

  await userEvent.type(secret, "secret-token");
  await userEvent.click(screen.getByRole("button", { name: "Save Connection" }));

  await waitFor(() =>
    expect(connections.createAdhocConnection).toHaveBeenCalledWith({
      origin: "https://api.example.com",
      rule: { location: "header", name: "authorization", valuePrefix: "Bearer " },
      secretValue: "secret-token",
      label: "api.example.com",
      scope: "personal",
    })
  );
  expect(await screen.findByRole("link", { name: "Return to Chat" })).toHaveAttribute(
    "href",
    "/chat/conversation-1"
  );
  expect(screen.queryByDisplayValue("secret-token")).not.toBeInTheDocument();
});

test("loader accepts only a same-origin Chat return path", async () => {
  vi.mocked(connections.getAdhocConnection).mockResolvedValue({
    origin: "https://api.example.com",
    state: "none",
  });
  const safe = await clientLoader({
    request: new Request(
      "https://farm.example/business/connections/new?origin=https%3A%2F%2Fapi.example.com&return_to=%2Fchat%2Fc1"
    ),
  } as ClientLoaderFunctionArgs);
  expect(safe.returnTo).toBe("/chat/c1");

  const unsafe = await clientLoader({
    request: new Request(
      "https://farm.example/business/connections/new?origin=https%3A%2F%2Fapi.example.com&return_to=https%3A%2F%2Fevil.example%2Fchat%2Fc1"
    ),
  } as ClientLoaderFunctionArgs);
  expect(unsafe.returnTo).toBeUndefined();
});

test("offers exact custom header attachment without putting the value in the URL", async () => {
  load();
  vi.mocked(connections.createAdhocConnection).mockResolvedValue({
    connectionId: "c1",
    origin: "https://api.example.com",
    scope: "personal",
  });
  renderRoute();

  await userEvent.click(screen.getByRole("radio", { name: "Custom" }));
  await userEvent.type(screen.getByLabelText(/^Header name/), "x-acme-token");
  await userEvent.type(screen.getByLabelText("Value prefix"), "Token ");
  await userEvent.type(screen.getByLabelText(/^Credential value/), "secret-token");
  await userEvent.click(screen.getByRole("button", { name: "Save Connection" }));

  await waitFor(() =>
    expect(connections.createAdhocConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: { location: "header", name: "x-acme-token", valuePrefix: "Token " },
        secretValue: "secret-token",
      })
    )
  );
});
