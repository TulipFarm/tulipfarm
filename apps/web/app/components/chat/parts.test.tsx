import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createSurfaceArtifact, surfaceActionKey } from "@tulipfarm/surface";
import { expect, test, vi } from "vitest";
import type { TimelinePart } from "~/lib/chat/types";
import { MessagePartView } from "./parts";

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

test("a failed presentation Tool remains available for diagnosis", () => {
  render(
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

  expect(screen.getByText("request_input")).toBeInTheDocument();
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

  expect(screen.getByText("Select one")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Which action should we take?" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Roll back" }));
  expect(onInteraction).toHaveBeenCalledWith("rollback-handle", { value: "rollback" });
  expect(screen.getByRole("button", { name: "Roll back, selected" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Keep investigating" })).toBeDisabled();
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
