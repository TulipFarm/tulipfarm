import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { type NativeChannelSetup, saveNativeRoutineRoute } from "~/lib/native-channels";
import { listRoutines, type RoutineSummary } from "~/lib/routines";
import { NativeRoutineRoutes } from "./native-routine-routes";

vi.mock("~/lib/native-channels", () => ({ saveNativeRoutineRoute: vi.fn() }));
vi.mock("~/lib/routines", () => ({ listRoutines: vi.fn() }));

const routine: RoutineSummary = {
  id: "routine-id",
  slug: "review-events",
  displayName: "Review events",
  authoredVersion: 1,
  triggers: [],
  summary: {
    owner: null,
    stateCount: 1,
    stateTypes: ["agent"],
    effects: ["agent"],
    toolAbilities: [],
    agentRefs: ["reviewer"],
    maxRiskClass: null,
    requiresApproval: true,
    concurrencyPolicy: null,
    compensationPolicy: null,
  },
};
const setup: NativeChannelSetup = {
  provider: "github",
  webhookUrl: "https://farm.example.com/api/v1/integrations/native/github/events",
  integrations: [{ id: "installation", externalTenantId: "12345", status: "active" }],
  routes: [],
  routineRoutes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listRoutines).mockResolvedValue([routine]);
  vi.mocked(saveNativeRoutineRoute).mockResolvedValue(setup);
});

function mount(value = setup) {
  const saved = vi.fn();
  const Stub = createRemixStub([
    { path: "/", Component: () => <NativeRoutineRoutes setup={value} onSaved={saved} /> },
  ]);
  render(<Stub />);
  return saved;
}

test("saves a disabled Routine event before account and destination approval", async () => {
  const saved = mount();
  await userEvent.click(await screen.findByRole("button", { name: "Add Routine event" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Routine provider account" }));
  await userEvent.click(await screen.findByRole("option", { name: /12345/ }));
  await userEvent.type(screen.getByLabelText("GitHub repository"), "example/repo");
  await userEvent.click(screen.getByRole("combobox", { name: "Event Routine" }));
  await userEvent.click(await screen.findByRole("option", { name: /Review events/ }));
  expect(screen.getByRole("link", { name: "Review Routine before enabling" })).toHaveAttribute(
    "href",
    "/routines/review-events"
  );
  expect(
    screen.queryByRole("checkbox", { name: "Enable this Routine event" })
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Save Routine event draft" }));
  expect(saveNativeRoutineRoute).toHaveBeenCalledWith("github", {
    integrationId: "installation",
    destination: "example/repo",
    eventType: "github.push",
    routineId: "routine-id",
    enabled: false,
  });
  expect(saved).toHaveBeenCalledWith(setup);
  expect(screen.getByRole("status")).toHaveTextContent("Routine event saved disabled.");
});

test("an existing Routine event can be disabled without changing its exact routing key", async () => {
  mount({
    ...setup,
    routineRoutes: [
      {
        id: "route",
        integrationId: "installation",
        destination: "example/repo",
        eventType: "github.push",
        routineId: "routine-id",
        enabled: true,
      },
    ],
  });
  await userEvent.click(await screen.findByRole("button", { name: "Edit Routine event" }));
  expect(screen.getByLabelText("GitHub repository")).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox", { name: "Enable this Routine event" }));
  await userEvent.click(screen.getByRole("button", { name: "Save Routine event" }));
  expect(saveNativeRoutineRoute).toHaveBeenCalledWith("github", {
    integrationId: "installation",
    destination: "example/repo",
    eventType: "github.push",
    routineId: "routine-id",
    enabled: false,
  });
});

test("missing current Routine approval remains actionable and never shows a saved route", async () => {
  vi.mocked(saveNativeRoutineRoute).mockRejectedValue(
    new ApiError(403, "Approval required.", undefined, "routine_approval_required")
  );
  const saved = mount({
    ...setup,
    routineRoutes: [
      {
        id: "route",
        integrationId: "installation",
        destination: "example/repo",
        eventType: "github.push",
        routineId: "routine-id",
        enabled: false,
      },
    ],
  });
  await userEvent.click(await screen.findByRole("button", { name: "Edit Routine event" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Enable this Routine event" }));
  await userEvent.click(screen.getByRole("button", { name: "Save Routine event" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "An admin must approve this Routine's current configuration."
  );
  expect(saved).not.toHaveBeenCalled();
  expect(screen.queryByText("Routine event enabled.")).not.toBeInTheDocument();
});
