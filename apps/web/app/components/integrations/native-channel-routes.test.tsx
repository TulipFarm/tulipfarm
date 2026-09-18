import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { listAgents } from "~/lib/agents";
import {
  getNativeChannelSetup,
  type NativeChannelSetup,
  saveNativeChannelSetup,
} from "~/lib/native-channels";
import { listUsers } from "~/lib/users";
import { NativeChannelRoutes } from "./native-channel-routes";

vi.mock("~/lib/agents", () => ({ listAgents: vi.fn() }));
vi.mock("~/lib/native-channels", () => ({
  getNativeChannelSetup: vi.fn(),
  saveNativeChannelSetup: vi.fn(),
}));
vi.mock("~/lib/users", () => ({ listUsers: vi.fn() }));

const setup: NativeChannelSetup = {
  provider: "slack",
  webhookUrl: "https://farm.example.com/api/v1/integrations/native/slack/events",
  integrations: [{ id: "workspace-installation", externalTenantId: "T123", status: "active" }],
  routes: [],
  routineRoutes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getNativeChannelSetup).mockResolvedValue(setup);
  vi.mocked(saveNativeChannelSetup).mockResolvedValue(setup);
  vi.mocked(listAgents).mockResolvedValue([{ name: "support", label: "Support Agent" }]);
  vi.mocked(listUsers).mockResolvedValue([
    {
      id: "user-1",
      name: "Muskan Vijayvargiya",
      email: "muskan@example.com",
      role: "member",
      status: "active",
    },
  ]);
});

function mount() {
  const Stub = createRemixStub([
    { path: "/", Component: () => <NativeChannelRoutes provider="slack" /> },
  ]);
  render(<Stub />);
}

test("creates a native route only after exact account, Agent, destination and users are chosen", async () => {
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "Add channel route" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Provider account" }));
  await userEvent.click(await screen.findByRole("option", { name: /T123/ }));
  await userEvent.type(screen.getByLabelText("Route ID"), "support-channel");
  await userEvent.click(screen.getByRole("combobox", { name: "Channel Agent" }));
  await userEvent.click(await screen.findByRole("option", { name: /Support Agent/ }));
  await userEvent.type(screen.getByLabelText("Slack channel ID"), "C123");
  expect(screen.getByRole("button", { name: "Save channel route" })).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox", { name: /Muskan Vijayvargiya/ }));
  await userEvent.click(screen.getByRole("button", { name: "Save channel route" }));
  expect(saveNativeChannelSetup).toHaveBeenCalledWith("slack", {
    integrationId: "workspace-installation",
    routeId: "support-channel",
    agentId: "support",
    channelId: "C123",
    principalIds: ["user-1"],
    enabled: true,
  });
  expect(await screen.findByRole("status")).toHaveTextContent("Channel route saved.");
});

test("editing preserves the actual persisted route ID and server-returned user grants", async () => {
  const routeId = "aabbccdd-1234-4567-a123-123456789abc";
  vi.mocked(getNativeChannelSetup).mockResolvedValue({
    ...setup,
    routes: [
      {
        id: routeId,
        integrationId: "workspace-installation",
        agentId: "support",
        channelId: "C123",
        threadId: null,
        eventTypes: ["message"],
        priority: 10,
        status: "active",
        principalIds: ["user-1"],
      },
    ],
  });
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "Edit route" }));
  expect(screen.getByLabelText("Route ID")).toHaveValue(routeId);
  expect(screen.getByText(/Current user grants are selected/)).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /Muskan Vijayvargiya/ })).toBeChecked();
  expect(screen.getByRole("button", { name: "Save channel route" })).toBeEnabled();
  await userEvent.click(screen.getByRole("checkbox", { name: "Enable this route" }));
  await userEvent.click(screen.getByRole("button", { name: "Save channel route" }));
  expect(saveNativeChannelSetup).toHaveBeenCalledWith(
    "slack",
    expect.objectContaining({
      routeId,
      enabled: false,
      principalIds: ["user-1"],
    })
  );
});

test("setup failures expose retry without claiming the channel is configured", async () => {
  vi.mocked(getNativeChannelSetup).mockRejectedValue(new Error("Channel setup unavailable."));
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Channel setup unavailable.");
  expect(screen.getByRole("button", { name: "Retry channel routes" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add channel route" })).not.toBeInTheDocument();
});
