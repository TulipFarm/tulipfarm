import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { deriveFields, parseSchema } from "~/lib/schema";
import ResourceCreate from "./_app.resources.$type.new";

/* Render the route directly because real data navigation creates jsdom-undici AbortSignal issues. */

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn(), useNavigate: vi.fn() };
});

vi.mock("~/lib/api", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api")>("~/lib/api");
  return { ...actual, createRecord: vi.fn() };
});

const api = await import("~/lib/api");

const parsed = parseSchema(`
type: object
properties:
  title: { type: string }
`);
if (!parsed.ok) throw new Error(parsed.error);
const fields = deriveFields(parsed.schema);

const navigate = vi.fn();

beforeEach(() => {
  vi.mocked(remix.useNavigate).mockReturnValue(navigate);
  vi.mocked(remix.useLoaderData).mockReturnValue({
    type: "ticket",
    fields,
    schemaError: undefined,
  });
  // Never settles: holds the Create in flight for the whole test, the way a slow POST would.
  vi.mocked(api.createRecord).mockReturnValue(new Promise(() => {}));
});

afterEach(() => vi.clearAllMocks());

function renderCreate() {
  const Stub = createRemixStub([{ path: "/", Component: () => <ResourceCreate /> }]);
  render(<Stub initialEntries={["/"]} />);
  return screen.getByRole("button", { name: /create/i });
}

// Two events inside one task, so React never gets a commit in between — the window in which a
// `disabled` prop driven by the parent's state does not exist yet.
function clickTwiceInOneTask(button: HTMLElement) {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

test("rapid double-click on Create submits exactly once", () => {
  clickTwiceInOneTask(renderCreate());
  expect(api.createRecord).toHaveBeenCalledTimes(1);
});

test("a second form submit while the first is in flight is ignored", () => {
  renderCreate();
  const form = document.querySelector("form");
  if (!form) throw new Error("no form rendered");
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(api.createRecord).toHaveBeenCalledTimes(1);
});

test("Create stays disabled while the request is in flight", () => {
  const button = renderCreate();
  fireEvent.click(button);
  expect(button).toBeDisabled();
});

test("a failed Create releases the guard so the user can retry", async () => {
  vi.mocked(api.createRecord).mockRejectedValueOnce(new ApiError(500, "boom"));
  const button = renderCreate();
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByText(/error: boom/i)).toBeInTheDocument());

  vi.mocked(api.createRecord).mockReturnValue(new Promise(() => {}));
  clickTwiceInOneTask(screen.getByRole("button", { name: /create/i }));
  expect(api.createRecord).toHaveBeenCalledTimes(2);
});
