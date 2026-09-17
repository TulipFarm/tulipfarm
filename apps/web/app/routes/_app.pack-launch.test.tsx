import type { ClientLoaderFunctionArgs } from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatPanel } from "~/components/chat/chat-panel";
import ChatRoute, { clientLoader } from "./_app._index";

vi.mock("~/lib/onboarding", () => ({ listOnboardingSuggestions: async () => [] }));
vi.mock("~/lib/use-session-user", () => ({ useSessionUser: () => undefined }));
vi.mock("~/components/chat/chat-panel", () => ({
  ChatPanel: (props: ComponentProps<typeof ChatPanel>) => (
    <div>
      <p>Mode: {props.initialMode ?? "normal"}</p>
      <p>Agent: {props.agentId ?? "main"}</p>
      <p>{props.initialLaunch?.prompt ?? "No launch"}</p>
      <button type="button" onClick={props.onLaunch}>
        Mark launch sent
      </button>
    </div>
  ),
}));

afterEach(() => window.history.replaceState(null, ""));

const loader = ({ request, params }: Pick<ClientLoaderFunctionArgs, "request" | "params">) =>
  clientLoader({
    request,
    params,
    context: undefined,
    serverLoader: async () => {
      throw new Error("SPA has no server loader");
    },
  });

test("the Pack handoff selects the main Agent in Plan mode and consumes history state once", async () => {
  const chatLaunch = { id: "pack-1", prompt: "The complete original Pack", mode: "plan" };
  window.history.replaceState(
    { key: "router-key", idx: 3, usr: { chatLaunch, other: "keep" } },
    ""
  );
  const Stub = createRemixStub([
    {
      path: "/",
      Component: ChatRoute,
      loader,
    },
  ]);
  render(
    <Stub
      initialEntries={[{ pathname: "/", search: "?agent=custom-agent", state: { chatLaunch } }]}
    />
  );
  expect(await screen.findByText("Mode: plan")).toBeInTheDocument();
  expect(screen.getByText("Agent: main")).toBeInTheDocument();
  expect(screen.getByText(chatLaunch.prompt)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Mark launch sent" }));
  expect(screen.getByText("No launch")).toBeInTheDocument();
  expect(window.history.state).toEqual({ key: "router-key", idx: 3, usr: { other: "keep" } });
});

test("normal Chat deep links retain their Agent without gaining Plan mode", async () => {
  const Stub = createRemixStub([{ path: "/", Component: ChatRoute, loader }]);
  render(<Stub initialEntries={["/?agent=custom-agent"]} />);
  expect(await screen.findByText("Mode: normal")).toBeInTheDocument();
  expect(screen.getByText("Agent: custom-agent")).toBeInTheDocument();
  expect(screen.getByText("No launch")).toBeInTheDocument();
});
