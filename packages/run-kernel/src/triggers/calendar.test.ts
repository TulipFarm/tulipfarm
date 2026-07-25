import { describe, expect, it } from "vitest";
import { type BusinessCalendar, isCalendarOpenAt, localPartsAt, zonedPartsToUtc } from "./calendar";

const NY = "America/New_York";

describe("localPartsAt", () => {
  it("reads wall-clock fields in the named IANA zone, not the host zone", () => {
    // 2026-07-25T14:30:00Z is 10:30 on a Saturday in New York (UTC-4).
    expect(localPartsAt(Date.parse("2026-07-25T14:30:00Z"), NY)).toEqual({
      year: 2026,
      month: 7,
      day: 25,
      hour: 10,
      minute: 30,
      weekday: 6,
    });
  });

  it("tracks the zone's own DST offset change", () => {
    const winter = localPartsAt(Date.parse("2026-01-15T14:00:00Z"), NY);
    const summer = localPartsAt(Date.parse("2026-07-15T14:00:00Z"), NY);

    expect(winter.hour).toBe(9);
    expect(summer.hour).toBe(10);
  });
});

describe("zonedPartsToUtc", () => {
  it("maps an unambiguous wall-clock time to exactly one instant", () => {
    expect(zonedPartsToUtc({ year: 2026, month: 7, day: 25, hour: 10, minute: 30 }, NY)).toEqual([
      Date.parse("2026-07-25T14:30:00Z"),
    ]);
  });

  it("reports a spring-forward gap as no instant at all", () => {
    // 02:30 on 2026-03-08 never happens in New York.
    expect(zonedPartsToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY)).toEqual([]);
  });

  it("reports a fall-back repeat as two instants, earliest first", () => {
    const instants = zonedPartsToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY);

    expect(instants).toEqual([
      Date.parse("2026-11-01T05:30:00Z"),
      Date.parse("2026-11-01T06:30:00Z"),
    ]);
  });
});

describe("isCalendarOpenAt", () => {
  const calendar: BusinessCalendar = {
    id: "hq",
    timezone: NY,
    openWeekdays: [1, 2, 3, 4, 5],
    closedDates: ["2026-07-03"],
  };

  it("is open on a declared weekday and closed at the weekend", () => {
    expect(isCalendarOpenAt(calendar, Date.parse("2026-07-02T14:00:00Z"))).toBe(true);
    expect(isCalendarOpenAt(calendar, Date.parse("2026-07-04T14:00:00Z"))).toBe(false);
  });

  it("is closed on an explicitly closed local date", () => {
    expect(isCalendarOpenAt(calendar, Date.parse("2026-07-03T14:00:00Z"))).toBe(false);
  });

  it("judges the date in the calendar's own zone, not UTC", () => {
    // 2026-07-04T02:00Z is still 2026-07-03 (a closed date) in New York.
    expect(isCalendarOpenAt(calendar, Date.parse("2026-07-04T02:00:00Z"))).toBe(false);
  });
});
