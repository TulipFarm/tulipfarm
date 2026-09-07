import type { OimPollingIngress } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { advancePollingCursor, PollingCursorError, pollingCursorRequestValue } from "./polling";

const POINTER_CURSOR: OimPollingIngress["cursor"] = {
  responsePointer: "/cursor",
  requestParameter: "cursor",
};

const MAX_INTEGER_CURSOR: OimPollingIngress["cursor"] = {
  mode: "max_integer_plus_one",
  responsePointer: "/result",
  itemPointer: "/update_id",
  requestParameter: "offset",
};

describe("polling cursor advancement", () => {
  it("keeps the existing opaque response-pointer behavior", () => {
    expect(advancePollingCursor({ cursor: "after-2" }, "after-1", POINTER_CURSOR)).toEqual({
      cursor: "after-2",
      deliveries: [
        {
          deduplicationKey: "after-2",
          payload: { cursor: "after-2" },
        },
      ],
    });
    expect(pollingCursorRequestValue("after-2", POINTER_CURSOR)).toBe("after-2");
  });

  it("advances to one past the largest integer item id", () => {
    expect(
      advancePollingCursor(
        { result: [{ update_id: 102 }, { update_id: 100 }, { update_id: 104 }] },
        "100",
        MAX_INTEGER_CURSOR
      )
    ).toEqual({
      cursor: "105",
      deliveries: [
        { deduplicationKey: "102", payload: { update_id: 102 } },
        { deduplicationKey: "100", payload: { update_id: 100 } },
        { deduplicationKey: "104", payload: { update_id: 104 } },
      ],
    });
    expect(pollingCursorRequestValue("105", MAX_INTEGER_CURSOR)).toBe(105);
  });

  it("preserves the current cursor when the provider returns no items", () => {
    expect(advancePollingCursor({ result: [] }, "105", MAX_INTEGER_CURSOR)).toEqual({
      cursor: "105",
      deliveries: [],
    });
    expect(advancePollingCursor({ result: [] }, null, MAX_INTEGER_CURSOR)).toEqual({
      cursor: null,
      deliveries: [],
    });
  });

  it.each([
    [{ result: "not-an-array" }, "response pointer did not select an array"],
    [{ result: [{}] }, "item 0 has no integer id"],
    [{ result: [{ update_id: "104" }] }, "item 0 has no integer id"],
    [{ result: [{ update_id: -1 }] }, "item 0 has no safe non-negative integer id"],
    [{ result: [{ update_id: 1.5 }] }, "item 0 has no integer id"],
    [
      { result: [{ update_id: Number.MAX_SAFE_INTEGER }] },
      "next cursor exceeds the safe integer range",
    ],
  ])("rejects malformed or unsafe provider ids", (response, message) => {
    expect(() => advancePollingCursor(response, null, MAX_INTEGER_CURSOR)).toThrow(
      new PollingCursorError(message)
    );
  });

  it.each(["01", "-1", "1.5", "9007199254740992"])(
    "rejects an unsafe persisted integer cursor: %s",
    (cursor) => {
      expect(() => pollingCursorRequestValue(cursor, MAX_INTEGER_CURSOR)).toThrow(
        PollingCursorError
      );
    }
  );
});
