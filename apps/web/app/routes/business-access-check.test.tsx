import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { type ExplainResult, explain, getEffectiveGrants } from "~/lib/authz";
import BusinessAccessCheck from "./_app.business.access.check";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRevalidator: vi.fn(() => ({ revalidate: vi.fn(), state: "idle" })),
  };
});

vi.mock("~/lib/authz", async () => ({
  // Spread the real module so the pure helpers (label maps, isLayerFault) stay real; stub only the
  // network calls. Replacing the whole module would silently blank the fault wording under test.
  ...(await vi.importActual<typeof import("~/lib/authz")>("~/lib/authz")),
  explain: vi.fn(),
  getEffectiveGrants: vi.fn(),
}));

const USERS = [
  {
    id: "user_123",
    email: "priya@cafe.test",
    name: "Priya Sharma",
    role: "member",
    status: "active",
  },
];
const RECORD_TYPES = ["customer"];

const BASE_RESULT: ExplainResult = {
  principalId: "user_123",
  kind: "user",
  allowed: false,
  reason: "no_matching_allow",
  evaluatedLayers: ["caller"],
  unevaluatedLayers: ["agent", "run", "guardrail", "credential"],
  partial: true,
};

function makeResult(overrides: Partial<ExplainResult>): ExplainResult {
  return { ...BASE_RESULT, ...overrides };
}

function renderPage() {
  vi.mocked(remix.useLoaderData).mockReturnValue({ users: USERS, recordTypes: RECORD_TYPES });
  vi.mocked(getEffectiveGrants).mockResolvedValue({
    principalId: "user_123",
    kind: "user",
    grants: [],
  });
  const Stub = createRemixStub([{ path: "/", Component: BusinessAccessCheck }]);
  render(<Stub initialEntries={["/"]} />);
}

/* The helper must derive raw policy strings from a person and Resource type. */
async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText(/^Who/), "user_123");
  await user.selectOptions(screen.getByLabelText(/^Trying to/), "read");
  await user.selectOptions(screen.getByLabelText(/^What/), "record.customer");
}

async function submitCheck(result: ExplainResult) {
  vi.mocked(explain).mockResolvedValueOnce(result);
  const user = userEvent.setup();
  renderPage();
  await fillRequiredFields(user);
  await user.click(screen.getByRole("button", { name: "Check" }));
  return user;
}

afterEach(() => {
  vi.clearAllMocks();
});

test("renders partial allow as qualified and shows unevaluated layers", async () => {
  await submitCheck(
    makeResult({
      allowed: true,
      reason: "allowed",
      evaluatedLayers: ["caller", "agent"],
      unevaluatedLayers: ["run", "guardrail", "credential"],
      partial: true,
    })
  );

  expect(await screen.findByText("Partial allow only")).toBeInTheDocument();
  expect(screen.getByText("This is not a guarantee.")).toBeInTheDocument();
  expect(screen.queryByText("Clean allow")).not.toBeInTheDocument();
  expect(screen.getAllByText("run").length).toBeGreaterThan(0);
  expect(screen.getAllByText("guardrail").length).toBeGreaterThan(0);
  expect(screen.getAllByText("credential").length).toBeGreaterThan(0);
});

/* Denial copy omits layer names; this panel is the only checked-layer disclosure. */
test("always discloses both evaluated and unevaluated layers, including on a denial", async () => {
  await submitCheck(
    makeResult({
      allowed: false,
      reason: "no_matching_allow",
      deniedLayer: "caller",
      evaluatedLayers: ["caller", "agent"],
      unevaluatedLayers: ["run", "guardrail", "credential"],
      partial: true,
    })
  );

  const scope = await screen.findByRole("region", { name: "Scope of this answer" });
  expect(within(scope).getByText("caller")).toBeInTheDocument();
  expect(within(scope).getByText("agent")).toBeInTheDocument();
  expect(within(scope).getByText("run")).toBeInTheDocument();
  expect(within(scope).getByText("guardrail")).toBeInTheDocument();
  expect(within(scope).getByText("credential")).toBeInTheDocument();
});

test("renders a full allow as a clean success", async () => {
  await submitCheck(
    makeResult({
      allowed: true,
      reason: "allowed",
      evaluatedLayers: ["caller", "agent", "run", "guardrail", "credential"],
      unevaluatedLayers: [],
      partial: false,
    })
  );

  expect(await screen.findByText("Clean allow")).toBeInTheDocument();
  expect(screen.getByText("Every layer available to this check permitted it.")).toBeInTheDocument();
});

test("renders explicit deny differently from no matching allow", async () => {
  await submitCheck(
    makeResult({
      allowed: false,
      reason: "explicit_deny",
      deniedLayer: "caller",
    })
  );

  expect(await screen.findByText("Explicit deny matched")).toBeInTheDocument();
  expect(screen.getByText("A deliberate deny rule matched this request.")).toBeInTheDocument();
  expect(
    screen.getByText("Find the deny rule on the named layer and change or remove that rule.")
  ).toBeInTheDocument();
  expect(screen.queryByText("No matching allow")).not.toBeInTheDocument();
});

test("renders no matching allow as default deny with its own remedy", async () => {
  await submitCheck(makeResult({ allowed: false, reason: "no_matching_allow" }));

  expect(await screen.findByText("No matching allow")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Nothing prohibited this request, but nothing granted it either. Default deny applies."
    )
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "Grant an allow that matches this action, resource type, and every narrowing dimension."
    )
  ).toBeInTheDocument();
  expect(screen.queryByText("Explicit deny matched")).not.toBeInTheDocument();
});

test("renders no layers as its own principal-resolution problem", async () => {
  await submitCheck(
    makeResult({
      allowed: false,
      reason: "no_layers",
      evaluatedLayers: [],
      unevaluatedLayers: ["agent", "run", "guardrail", "credential"],
    })
  );

  expect(await screen.findByText("No authority layer resolved")).toBeInTheDocument();
  expect(
    screen.getByText("The principal did not resolve to any durable authority layer.")
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "Fix the principal first. Check that the ID exists in the authorization system."
    )
  ).toBeInTheDocument();
});

test("shows the denied layer when the server names one", async () => {
  await submitCheck(
    makeResult({
      allowed: false,
      reason: "explicit_deny",
      deniedLayer: "agent",
    })
  );

  expect(await screen.findByText("Denied layer:")).toBeInTheDocument();
  expect(screen.getAllByText("agent").length).toBeGreaterThan(0);
});

test("omits empty optional fields from the explain request", async () => {
  await submitCheck(makeResult({ allowed: false, reason: "no_matching_allow" }));

  await waitFor(() =>
    expect(explain).toHaveBeenCalledWith({
      principalId: "user_123",
      action: "record.read",
      resourceType: "record.customer",
    })
  );
});

test("passes agentId through when supplied", async () => {
  vi.mocked(explain).mockResolvedValueOnce(makeResult({ allowed: false }));
  const user = userEvent.setup();
  renderPage();
  await fillRequiredFields(user);
  await user.type(screen.getByLabelText("Agent ID"), "agent_sales");
  await user.click(screen.getByRole("button", { name: "Check" }));

  await waitFor(() =>
    expect(explain).toHaveBeenCalledWith({
      principalId: "user_123",
      action: "record.read",
      resourceType: "record.customer",
      agentId: "agent_sales",
    })
  );
});

test("renders 403 as not a deployment admin", async () => {
  vi.mocked(explain).mockRejectedValueOnce(new ApiError(403, "forbidden"));
  const user = userEvent.setup();
  renderPage();
  await fillRequiredFields(user);
  await user.click(screen.getByRole("button", { name: "Check" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("not a deployment admin");
});

test("renders 404 as an unknown principal", async () => {
  vi.mocked(explain).mockRejectedValueOnce(new ApiError(404, "missing"));
  const user = userEvent.setup();
  renderPage();
  await fillRequiredFields(user);
  await user.click(screen.getByRole("button", { name: "Check" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "principal is not known to the authorization system"
  );
});

test("separates a denial caused by broken data from a denial caused by policy", async () => {
  // `deniedLayer: "user"` looks identical whether the layer weighed the request and said no or
  // never resolved at all. Here it emptied because an assignment names a Role the store does not
  // have, so the reason panel's remedy — author a grant — cannot work until the data is repaired.
  vi.mocked(explain).mockResolvedValueOnce(
    makeResult({
      deniedLayer: "user",
      layerEmptyReasons: { user: "unknown-role" },
      unresolvedRoleIds: ["vanished"],
    })
  );
  const user = userEvent.setup();
  renderPage();
  await fillRequiredFields(user);
  await user.click(screen.getByRole("button", { name: "Check" }));

  expect(
    await screen.findByText(/this is a data fault, not a policy decision/i)
  ).toBeInTheDocument();
  expect(screen.getByText(/no longer exists/i)).toBeInTheDocument();
  expect(screen.getByText("vanished")).toBeInTheDocument();
});

test("stays quiet when every empty layer emptied for an ordinary reason", async () => {
  vi.mocked(explain).mockResolvedValueOnce(
    makeResult({ deniedLayer: "user", layerEmptyReasons: { user: "no-roles-assigned" } })
  );
  const user = userEvent.setup();
  renderPage();
  await fillRequiredFields(user);
  await user.click(screen.getByRole("button", { name: "Check" }));

  await screen.findByText(/denied layer/i);
  expect(screen.queryByText(/this is a data fault/i)).not.toBeInTheDocument();
});

/* Connected apps has no `integration.update`; offering change would create a false denial. */
test("only offers verbs the chosen thing actually has an action for", async () => {
  const user = userEvent.setup();
  renderPage();

  await user.selectOptions(screen.getByLabelText(/^What/), "integration");

  const verbs = within(screen.getByLabelText(/^Trying to/))
    .getAllByRole("option")
    .map((option) => option.textContent);
  expect(verbs).toEqual(["view", "add", "delete"]);
});

test("sends the action the gate really evaluates, not one composed from the verb", async () => {
  vi.mocked(explain).mockResolvedValueOnce(makeResult({ allowed: true, reason: undefined }));
  const user = userEvent.setup();
  renderPage();

  await user.selectOptions(screen.getByLabelText(/^Who/), "user_123");
  await user.selectOptions(screen.getByLabelText(/^What/), "integration");
  await user.selectOptions(screen.getByLabelText(/^Trying to/), "create");
  await user.click(screen.getByRole("button", { name: "Check" }));

  await waitFor(() =>
    expect(explain).toHaveBeenCalledWith(
      expect.objectContaining({ action: "integration.connect", resourceType: "integration" })
    )
  );
});
