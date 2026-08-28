import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createSurfaceArtifact, surfaceActionKey } from "@tulipfarm/surface";
import { expect, test, vi } from "vitest";
import type { TimelinePart } from "~/lib/chat/types";
import { MessagePartView } from "./parts";

/** Every narration part is chrome-free: the Trace rail is the only presentation interior work gets. */
const NARRATION_PARTS: { name: string; part: TimelinePart }[] = [
  {
    name: "sources",
    part: {
      kind: "sources",
      sources: [
        { id: "a", title: "Supplier terms", url: "https://example.com/terms", ref: 1 },
        { id: "b", title: "Stock policy", url: "/knowledge/stock", path: "ops/stock.md", ref: 2 },
      ],
    },
  },
  { name: "agent-handoff", part: { kind: "agent-handoff", to: "Ops", reason: "needs inventory" } },
  {
    name: "guardrail",
    part: { kind: "guardrail", stage: "output", reason: "policy", message: "Refunds are capped" },
  },
];

/** Sources link in-app, so these parts need a router around them. */
function renderPart(part: TimelinePart) {
  const Stub = createRemixStub([
    { path: "/", Component: () => <MessagePartView part={part} onApprove={() => undefined} /> },
  ]);
  return render(<Stub />);
}

test.each(NARRATION_PARTS)("the $name part narrates on the rail, without a box", ({ part }) => {
  const { container } = renderPart(part);

  // A box costs a border and a radius above the answer the reader asked for, and buys nothing the
  // rail does not already carry.
  expect(container.querySelectorAll(".border-run-border")).toHaveLength(0);
  expect(container.querySelectorAll("[class*='rounded-md'][class*='border-']")).toHaveLength(0);
});

test("a guardrail refusal is toned, not boxed, and names what was blocked", () => {
  renderPart({
    kind: "guardrail",
    stage: "output",
    reason: "policy",
    message: "Refunds are capped",
  });

  expect(screen.getByText("Blocked")).toHaveClass("text-run-blocked");
  expect(screen.getByText("Refunds are capped")).toBeInTheDocument();
});

test("an internal source routes in-app while an external one opens away", () => {
  renderPart({
    kind: "sources",
    sources: [
      { id: "a", title: "Supplier terms", url: "https://example.com/terms" },
      { id: "b", title: "Stock policy", url: "/knowledge/stock" },
    ],
  });

  // A full page load inside a chat transcript would cost the reader the conversation.
  expect(screen.getByRole("link", { name: /Stock policy/ })).not.toHaveAttribute("target");
  expect(screen.getByRole("link", { name: /Supplier terms/ })).toHaveAttribute("target", "_blank");
});

test("a Surface part renders the native React renderer", () => {
  const artifact = createSurfaceArtifact({
    id: "status",
    component: { name: "Status", version: "1.0" },
    props: { label: "Ready" },
    target: { channel: "web", surface: "chat" },
    audience: ["user:1"],
    classification: "internal",
  });
  const part: TimelinePart = {
    kind: "surface",
    artifactId: artifact.id,
    revision: artifact.revision,
    artifact,
  };
  render(
    <MessagePartView part={part} onApprove={() => undefined} onSurfaceInteraction={vi.fn()} />
  );
  expect(screen.getByRole("status")).toHaveTextContent("Ready");
});

test("an unavailable historical presentation shows the fixed notice", () => {
  render(
    <MessagePartView
      part={{
        kind: "surface-unavailable",
        message: "Legacy presentation unavailable",
      }}
      onApprove={() => undefined}
    />
  );
  expect(screen.getByRole("status")).toHaveTextContent("Legacy presentation unavailable");
});

test("a successful presentation Tool is hidden once its Surface is available", () => {
  render(
    <MessagePartView
      part={{
        kind: "tool",
        toolCallId: "request-1",
        toolName: "request_input",
        args: {},
        result: { success: true, data: { artifactId: "decision", revision: 1 } },
        status: "done",
      }}
      onApprove={() => undefined}
    />
  );

  expect(screen.queryByText("request_input")).toBeNull();
});

test("a presentation Tool never draws a row, even when it failed", () => {
  const { container } = render(
    <MessagePartView
      part={{
        kind: "tool",
        toolCallId: "request-1",
        toolName: "request_input",
        args: {},
        result: {
          success: false,
          error: { code: "internal_error", message: "Presentation unavailable" },
        },
        status: "done",
      }}
      onApprove={() => undefined}
    />
  );

  // The agent retries presentation failures itself. Surfacing one puts a red row above a reply
  // that rendered perfectly well, describing plumbing the reader did not ask about.
  expect(container).toBeEmptyDOMElement();
});

test("Choices render as a decision card and lock after selection", async () => {
  const user = userEvent.setup();
  const action = { event: "incident.choose" };
  const artifact = createSurfaceArtifact({
    id: "decision",
    component: { name: "Choices", version: "1.0" },
    props: {
      question: "Which action should we take?",
      choices: [
        { label: "Roll back", value: "rollback" },
        { label: "Keep investigating", value: "investigate" },
      ],
      action,
    },
    target: { channel: "web", surface: "chat" },
    audience: ["user:1"],
    classification: "internal",
  });
  const onInteraction = vi.fn();
  const actionHandles = {
    [surfaceActionKey({ ...action, payload: { value: "rollback" } })]: "rollback-handle",
    [surfaceActionKey({ ...action, payload: { value: "investigate" } })]: "investigate-handle",
  };

  render(
    <MessagePartView
      part={{
        kind: "surface",
        artifactId: artifact.id,
        revision: artifact.revision,
        artifact,
        actionHandles,
      }}
      onApprove={() => undefined}
      onSurfaceInteraction={onInteraction}
    />
  );

  expect(screen.getByRole("heading", { name: "Which action should we take?" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Roll back" }));
  expect(onInteraction).toHaveBeenCalledWith("rollback-handle", { value: "rollback" });
  expect(screen.getByRole("button", { name: "Roll back, selected" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Keep investigating" })).toBeDisabled();
});

function recommendationArtifact(recommend?: string) {
  return createSurfaceArtifact({
    id: "restock",
    component: { name: "Choices", version: "1.0" },
    props: {
      question: "Want me to place this restock order?",
      choices: [
        {
          label: "Reorder from cone_king",
          value: "reorder",
          detail: "Reorder waffle cones from `cone_king` with lead time `7_days`.",
          confidence: "high",
        },
        {
          label: "Switch to vanilla_madagascar",
          value: "switch",
          detail: "Switch vanilla to `vanilla_madagascar` for peak season.",
          confidence: "medium",
        },
        { label: "Full restock across every SKU", value: "restock" },
      ],
      recommend,
      action: { event: "restock.choose" },
    },
    target: { channel: "web", surface: "chat" },
    audience: ["user:1"],
    classification: "internal",
  });
}

function renderChoices(
  artifact: ReturnType<typeof recommendationArtifact>,
  onInteraction = vi.fn()
) {
  const action = { event: "restock.choose" };
  const actionHandles = {
    [surfaceActionKey({ ...action, payload: { value: "reorder" } })]: "reorder-handle",
    [surfaceActionKey({ ...action, payload: { value: "switch" } })]: "switch-handle",
    [surfaceActionKey({ ...action, payload: { value: "restock" } })]: "restock-handle",
  };
  render(
    <MessagePartView
      part={{
        kind: "surface",
        artifactId: artifact.id,
        revision: artifact.revision,
        artifact,
        actionHandles,
      }}
      onApprove={() => undefined}
      onSurfaceInteraction={onInteraction}
    />
  );
  return onInteraction;
}

test("a recommended choice leads the card and files the rest behind Alternatives", async () => {
  const user = userEvent.setup();
  const onInteraction = renderChoices(recommendationArtifact("reorder"));

  // The lead is prose the reader can act on without opening anything.
  expect(screen.getByText(/Reorder waffle cones from/)).toBeInTheDocument();
  expect(screen.getByText("High confidence")).toBeInTheDocument();
  const alternatives = screen.getByRole("button", { name: "Alternatives" });
  expect(alternatives).toHaveAttribute("aria-expanded", "false");

  await user.click(alternatives);
  expect(alternatives).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Switch to vanilla_madagascar")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Reorder from cone_king" }));
  expect(onInteraction).toHaveBeenCalledWith("reorder-handle", { value: "reorder" });
  expect(screen.getByRole("button", { name: "Accepted" })).toBeDisabled();
});

test("promoting an alternative makes it the recommendation the primary action commits", async () => {
  const user = userEvent.setup();
  const onInteraction = renderChoices(recommendationArtifact("reorder"));

  await user.click(screen.getByRole("button", { name: "Alternatives" }));
  await user.click(screen.getByRole("button", { name: /Switch to vanilla_madagascar/ }));

  // Promotion has to move the commit too, or the card offers one option and submits another.
  expect(screen.getByText(/Switch vanilla to/)).toBeInTheDocument();
  expect(screen.getByText("Needs review")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Switch to vanilla_madagascar" }));
  expect(onInteraction).toHaveBeenCalledWith("switch-handle", { value: "switch" });
});

test("without a recommendation the card keeps every option at equal weight", () => {
  // Leading with one option is the agent making a recommendation. It must never make one it did not.
  renderChoices(recommendationArtifact(undefined));

  expect(screen.getByRole("button", { name: "Reorder from cone_king" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Switch to vanilla_madagascar" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Alternatives" })).toBeNull();
  expect(screen.queryByText("High confidence")).toBeNull();
});

test("an option with no stated confidence says so rather than showing an empty meter", async () => {
  const user = userEvent.setup();
  renderChoices(recommendationArtifact("reorder"));

  await user.click(screen.getByRole("button", { name: "Alternatives" }));
  await user.click(screen.getByRole("button", { name: /Full restock/ }));

  // An unstated confidence is not a low one, and bare grey bars would claim it was.
  expect(screen.getByText("No signal")).toBeInTheDocument();
});

test("backticks in agent prose render as inline code, not literal backticks", () => {
  renderChoices(recommendationArtifact("reorder"));

  const code = document.querySelector("[data-surface-code]");
  expect(code).toHaveTextContent("cone_king");
  expect(screen.queryByText(/`cone_king`/)).toBeNull();
});

test("Form renders typed controls and submits their structured values", async () => {
  const user = userEvent.setup();
  const action = { event: "contact.submit" };
  const artifact = createSurfaceArtifact({
    id: "contact",
    component: { name: "Form", version: "1.0" },
    props: {
      title: "Contact details",
      fields: [
        { name: "email", label: "Email", input: "email", required: true },
        {
          name: "priority",
          label: "Priority",
          input: "select",
          options: ["Low", "High"],
        },
        { name: "notes", label: "Notes", input: "textarea" },
        { name: "subscribe", label: "Send updates", input: "checkbox" },
      ],
      submit: "Continue",
      action,
    },
    target: { channel: "web", surface: "chat" },
    audience: ["user:1"],
    classification: "internal",
  });
  const onInteraction = vi.fn();

  render(
    <MessagePartView
      part={{
        kind: "surface",
        artifactId: artifact.id,
        revision: artifact.revision,
        artifact,
        actionHandles: { [surfaceActionKey(action)]: "form-handle" },
      }}
      onApprove={() => undefined}
      onSurfaceInteraction={onInteraction}
    />
  );

  await user.type(screen.getByRole("textbox", { name: /email/i }), "sam@example.com");
  await user.selectOptions(screen.getByRole("combobox", { name: "Priority" }), "High");
  await user.type(screen.getByRole("textbox", { name: "Notes" }), "Call tomorrow");
  await user.click(screen.getByRole("checkbox", { name: "Send updates" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));

  expect(onInteraction).toHaveBeenCalledWith("form-handle", {
    email: "sam@example.com",
    priority: "High",
    notes: "Call tomorrow",
    subscribe: true,
  });
});
