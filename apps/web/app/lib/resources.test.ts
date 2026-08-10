import { expect, test } from "vitest";
import { formatBucketLabel, formatBytes, formatCpuPct } from "./resources";

test("formats CPU to one decimal, including above a full core", () => {
  expect(formatCpuPct(0)).toBe("0.0%");
  expect(formatCpuPct(12.345)).toBe("12.3%");
  // A process saturating two cores must not be clamped or rounded into looking healthy.
  expect(formatCpuPct(213.7)).toBe("213.7%");
});

test("formats bytes in binary units, matching what top reports", () => {
  expect(formatBytes(0)).toBe("0 MB");
  expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  // A decimal stops carrying information once the integer part has three digits.
  expect(formatBytes(1024 * 1024 * 9.5)).toBe("9.5 MB");
  expect(formatBytes(1024 * 1024 * 250)).toBe("250 MB");
  expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe("2.50 GB");
});

test("treats a missing or nonsensical byte count as zero rather than NaN", () => {
  expect(formatBytes(Number.NaN)).toBe("0 MB");
  expect(formatBytes(-1)).toBe("0 MB");
});

test("labels buckets with clock time and passes an unparseable value through", () => {
  expect(formatBucketLabel("2025-01-01T09:05:00.000Z")).toMatch(/\d{2}:\d{2}/);
  expect(formatBucketLabel("not-a-date")).toBe("not-a-date");
});
