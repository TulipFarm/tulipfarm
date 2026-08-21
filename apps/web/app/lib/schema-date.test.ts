import { afterAll, beforeAll, expect, test } from "vitest";
import {
  cellText,
  deriveFields,
  type FieldDescriptor,
  parseSchema,
  renderValue,
} from "~/lib/schema";

/* Pinned west of Greenwich: a bare YYYY-MM-DD read as UTC midnight lands on the previous day here,
   which is the half of the date-only defect a locale-agnostic assertion cannot see. */
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
  process.env.TZ = originalTz;
});

const DATE_YAML = `
type: object
properties:
  id: { type: string }
  due: { type: string, format: date }
  startsAt: { type: string, format: date-time }
`;

function fields(): Record<string, FieldDescriptor> {
  const parsed = parseSchema(DATE_YAML);
  if (!parsed.ok) throw new Error(parsed.error);
  return Object.fromEntries(deriveFields(parsed.schema).map((f) => [f.name, f]));
}

function text(field: FieldDescriptor, value: unknown): string {
  const cell = renderValue(field, value);
  if (cell.kind !== "text") throw new Error(`expected a text cell, got ${cell.kind}`);
  return cell.text;
}

test("a format: date field renders the calendar day it was given, not the UTC-shifted one", () => {
  expect(text(fields().due, "2026-03-15")).toContain("15");
  expect(text(fields().due, "2026-03-15")).toContain("2026");
});

test("a format: date field renders no time of day", () => {
  expect(text(fields().due, "2026-03-15")).not.toMatch(/\d:\d/);
});

test("a format: date-time field keeps its time of day", () => {
  expect(text(fields().startsAt, "2026-03-15T18:30:00Z")).toMatch(/\d:\d/);
});

test("system date-time columns keep their time of day", () => {
  const updatedAt: FieldDescriptor = {
    name: "updatedAt",
    kind: "date",
    isSystem: true,
    isIdField: false,
  };
  expect(text(updatedAt, "2026-06-08T14:03:00Z")).toMatch(/\d:\d/);
});

test("filter text for a format: date field matches the day the user sees", () => {
  expect(cellText(fields().due, "2026-03-15")).toContain("15");
  expect(cellText(fields().due, "2026-03-15")).not.toMatch(/\d:\d/);
});

test("a malformed date-only value passes through unchanged", () => {
  expect(text(fields().due, "not-a-date")).toBe("not-a-date");
});
