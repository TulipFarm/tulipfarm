import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";

vi.mock("~/lib/channel-links", () => ({
  previewChannelBind: vi.fn(),
  confirmChannelBind: vi.fn(),
}));

import { confirmChannelBind, previewChannelBind } from "~/lib/channel-links";
import LinkChannelRoute, { clientLoader, ErrorBoundary } from "./_app.link-channel";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn(), useRouteError: vi.fn() };
});

const OFFER = {
  slug: "chatapp",
  senderId: "U123",
  expiresAt: new Date("2026-01-01T00:15:00.000Z").toISOString(),
  account: { userId: "u1", email: "alice@example.com" },
};

function renderPage(data: unknown) {
  vi.mocked(remix.useLoaderData).mockReturnValue(data);
  const Stub = createRemixStub([{ path: "/", Component: () => <LinkChannelRoute /> }]);
  render(<Stub initialEntries={["/"]} />);
}

function load(url: string) {
  return clientLoader({
    request: new Request(url),
    params: {},
    context: undefined,
    // SPA mode has no server loader; the signature still declares one.
    serverLoader: async () => {
      throw new Error("no server loader in SPA mode");
    },
  });
}

beforeEach(() => vi.clearAllMocks());

test("refuses a link with no token, without asking the API about one", async () => {
  await expect(load("http://web/link-channel")).rejects.toBeInstanceOf(ApiError);
  expect(previewChannelBind).not.toHaveBeenCalled();
});

test("describes the offer without spending it", async () => {
  vi.mocked(previewChannelBind).mockResolvedValue(OFFER);

  const data = await load("http://web/link-channel?token=abc");

  expect(previewChannelBind).toHaveBeenCalledWith("abc");
  expect(confirmChannelBind).not.toHaveBeenCalled();
  expect(data).toMatchObject({ token: "abc", offer: OFFER });
});

test("names the sender and the account before anything is bound", () => {
  renderPage({ token: "abc", offer: OFFER });

  expect(screen.getByRole("heading", { level: 1, name: "Link channel" })).toBeInTheDocument();
  expect(screen.getByText("U123")).toBeInTheDocument();
  expect(screen.getByText("chatapp")).toBeInTheDocument();
  expect(screen.getByText("alice@example.com")).toBeInTheDocument();
  expect(confirmChannelBind).not.toHaveBeenCalled();
});

test("binds only on an explicit confirm, then says what was bound", async () => {
  vi.mocked(confirmChannelBind).mockResolvedValue({
    link: {
      provider: "chatapp",
      externalSubject: "U123",
      userId: "u1",
      verifiedAt: new Date().toISOString(),
    },
  });
  renderPage({ token: "abc", offer: OFFER });

  await userEvent.click(screen.getByRole("button", { name: /bind to my account/i }));

  expect(confirmChannelBind).toHaveBeenCalledWith("abc");
  expect(await screen.findByText(/now acts as/)).toBeInTheDocument();
});

test("keeps the page unbound when the API refuses the token, showing why", async () => {
  vi.mocked(confirmChannelBind).mockRejectedValue(new ApiError(400, "bind link is not usable"));
  renderPage({ token: "abc", offer: OFFER });

  await userEvent.click(screen.getByRole("button", { name: /bind to my account/i }));

  expect(await screen.findByText("bind link is not usable")).toBeInTheDocument();
  expect(screen.queryByText(/now acts as/)).not.toBeInTheDocument();
});

test("tells a holder of a dead link how to get a live one", () => {
  vi.mocked(remix.useRouteError).mockReturnValue(new ApiError(400, "bind link is not usable"));

  render(<ErrorBoundary />);

  expect(screen.getByRole("heading", { level: 1, name: "Link channel" })).toBeInTheDocument();
  expect(screen.getByText(/400 bind link is not usable/)).toBeInTheDocument();
  expect(screen.getByText(/works once and expires/)).toBeInTheDocument();
});
