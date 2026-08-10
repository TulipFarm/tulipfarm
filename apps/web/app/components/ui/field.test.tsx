import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Field, ReadonlyField } from "./field";
import { Input } from "./input";

test("associates the label with the control it wraps", () => {
  render(
    <Field label="Display name">
      <Input defaultValue="Priya Raghunathan" />
    </Field>
  );

  expect(screen.getByLabelText("Display name")).toHaveValue("Priya Raghunathan");
});

test("describes the control with its help text", () => {
  render(
    <Field label="Website" help="Include the protocol.">
      <Input />
    </Field>
  );

  expect(screen.getByLabelText("Website")).toHaveAccessibleDescription("Include the protocol.");
});

test("marks the control invalid and announces the error", () => {
  // Color alone never carries the message, so the error has to reach the accessibility tree too.
  render(
    <Field label="Website" error="Enter a valid URL.">
      <Input />
    </Field>
  );

  const control = screen.getByLabelText("Website");
  expect(control).toHaveAttribute("aria-invalid", "true");
  expect(control).toHaveAccessibleDescription("Enter a valid URL.");
});

test("keeps an explicit id the caller already set", () => {
  render(
    <Field label="Key" htmlFor="secret-key">
      <Input id="secret-key" />
    </Field>
  );

  expect(screen.getByLabelText("Key")).toHaveAttribute("id", "secret-key");
});

test("renders a read-only pair as a description list entry", () => {
  render(
    <dl>
      <ReadonlyField label="Email">ops@northwind.example</ReadonlyField>
    </dl>
  );

  expect(screen.getByText("Email").tagName).toBe("DT");
  expect(screen.getByText("ops@northwind.example").tagName).toBe("DD");
});
