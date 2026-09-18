import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { listAgents } from "~/lib/agents";
import { connectIntegration, type IntegrationDetail } from "~/lib/integrations";
import { getNativeChannelSetup } from "~/lib/native-channels";
import { listUsers } from "~/lib/users";
import { NativeChannelDetail } from "./native-channel-detail";

let admin = true;
vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => admin }));
vi.mock("~/lib/agents", () => ({ listAgents: vi.fn() }));
vi.mock("~/lib/users", () => ({ listUsers: vi.fn() }));
vi.mock("~/lib/native-channels", () => ({
  getNativeChannelSetup: vi.fn(),
  saveNativeChannelSetup: vi.fn(),
}));
vi.mock("~/lib/integrations", async (original) => ({
  ...(await original<typeof import("~/lib/integrations")>()),
  connectIntegration: vi.fn(),
}));

beforeEach(() => {
  admin = true;
  vi.clearAllMocks();
  vi.mocked(listAgents).mockResolvedValue([]);
  vi.mocked(listUsers).mockResolvedValue([]);
  vi.mocked(getNativeChannelSetup).mockResolvedValue({
    provider: "slack",
    webhookUrl: "https://farm.example.com/api/v1/integrations/native/slack/events",
    integrations: [],
    routes: [],
    routineRoutes: [],
  });
});

function mount(overrides: Partial<IntegrationDetail> = {}) {
  const integration: IntegrationDetail = {
    name: "slack",
    title: "Slack",
    installed: true,
    type: "none",
    status: "disconnected",
    connected: false,
    auth: [{ index: 0, kind: "fields", satisfied: true, producesEnv: true, fields: [] }],
    grants: [],
    manifest: {},
    ...overrides,
  };
  const onChanged = vi.fn();
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <NativeChannelDetail integration={integration} installations={[]} onChanged={onChanged} />
      ),
    },
  ]);
  render(<Stub />);
  return onChanged;
}

test("reconnects the native channel and refreshes only after persistence", async () => {
  vi.mocked(connectIntegration).mockResolvedValue({ status: "connected", toolCount: 0 });
  const changed = mount();
  await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
  expect(connectIntegration).toHaveBeenCalledWith("slack", {});
  expect(changed).toHaveBeenCalledOnce();
});

test("shows a native channel reconnect failure", async () => {
  vi.mocked(connectIntegration).mockRejectedValue(new Error("Channel credentials expired."));
  const changed = mount();
  await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Channel credentials expired.");
  expect(changed).not.toHaveBeenCalled();
});

test("members cannot manage shared native channel credentials", async () => {
  admin = false;
  mount();
  expect(await screen.findByText("Ask an admin to connect this channel.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
});

test("retains native Slack routing and excludes Slack Knowledge sync", async () => {
  mount({ connected: true, status: "connected" });
  expect(await screen.findByText(/Slack content is not synced into Knowledge/)).toBeInTheDocument();
  expect(
    await screen.findByText(/Connected credentials alone do not authorize incoming messages/)
  ).toBeInTheDocument();
  expect(getNativeChannelSetup).toHaveBeenCalledWith("slack");
  expect(screen.getByText("Credentials connected")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Set up in Chat" })).not.toBeInTheDocument();
});
