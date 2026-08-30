import { describe, expect, test } from "vitest";
import { describeCron } from "./cron";

describe("describeCron", () => {
  test.each([
    ["0 9 * * 1-5", "Every weekday at 9:00 AM"],
    ["0 9 * * *", "Every day at 9:00 AM"],
    ["0 9 * * 1", "Every Monday at 9:00 AM"],
    ["30 14 * * 0,6", "Every weekend day at 2:30 PM"],
    ["0 0 * * *", "Every day at 12:00 AM"],
    ["0 12 * * *", "Every day at 12:00 PM"],
    ["15 8 * * 1,3,5", "Every Monday, Wednesday and Friday at 8:15 AM"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["*/5 * * * 1-5", "Every 5 minutes, every weekday"],
    ["0 * * * *", "Every hour, on the hour"],
    ["30 * * * *", "Every hour, at 30th past the hour"],
    ["* * * * *", "Every minute"],
    ["0 */6 * * *", "Every 6 hours, on the hour"],
    ["0 0 1 * *", "On the 1st of every month at 12:00 AM"],
    ["0 0 2 * *", "On the 2nd of every month at 12:00 AM"],
    ["0 0 3 * *", "On the 3rd of every month at 12:00 AM"],
    ["0 0 11 * *", "On the 11th of every month at 12:00 AM"],
    ["0 9 25 12 *", "Every December 25th at 9:00 AM"],
    ["0 9,17 * * *", "Every day at 9:00 AM and 5:00 PM"],
    // Cron spells Sunday 0 or 7; both must read the same.
    ["0 9 * * 7", "Every Sunday at 9:00 AM"],
    ["0 9 * * 0", "Every Sunday at 9:00 AM"],
    ["0 9 * * 0-6", "Every day at 9:00 AM"],
  ])("reads %s as %s", (expression, expected) => {
    expect(describeCron(expression)).toBe(expected);
  });

  test.each([
    ["0 9 * *", "too few fields"],
    ["0 9 * * 1-5 *", "too many fields"],
    ["0 9 1 * 1", "day-of-month and day-of-week both set, which cron ORs"],
    ["0 9 L * *", "an operator this does not implement"],
    ["0 9 * * 1#2", "an nth-weekday operator"],
    ["60 9 * * *", "a minute out of range"],
    ["0 24 * * *", "an hour out of range"],
    ["0 9 * * 8", "a weekday out of range"],
    ["0 9 * */2 *", "a stepped month"],
    ["0 9 * * */2", "a stepped weekday"],
  ])("refuses %s (%s) rather than guess", (expression) => {
    expect(describeCron(expression)).toBeNull();
  });
});
