import { describe, expect, it } from "vitest";
import { assertKnownFlags, flag, positive } from "./args.ts";

describe("flag", () => {
  it("reads the separated form", () => {
    expect(flag(["--max-tokens", "20000"], "--max-tokens")).toBe("20000");
  });

  it("reads the joined form, which used to yield no ceiling at all", () => {
    // `indexOf` alone never matched `--max-tokens=20000`, so the Sweep ran unbounded while the
    // operator believed they had capped it. A seat's quota is finite; that is a real loss.
    expect(flag(["--max-tokens=20000"], "--max-tokens")).toBe("20000");
  });

  it("returns nothing when the option is absent", () => {
    expect(flag(["--model", "sonnet"], "--max-tokens")).toBeUndefined();
  });
});

describe("assertKnownFlags", () => {
  it("accepts the supported options in either form", () => {
    expect(() =>
      assertKnownFlags(["--model", "sonnet", "--max-tokens=20000", "--help"])
    ).not.toThrow();
  });

  it("refuses a typo rather than treating it as an absent ceiling", () => {
    expect(() => assertKnownFlags(["--model", "sonnet", "--max-token", "20000"])).toThrow(
      /unknown option "--max-token"/
    );
  });

  it("leaves bare values alone", () => {
    expect(() => assertKnownFlags(["--case", "support-answers-without-tools"])).not.toThrow();
  });
});

describe("positive", () => {
  it("rejects a value that could not bound anything", () => {
    expect(() => positive("0", "--max-tokens")).toThrow(/must be a positive number/);
    expect(() => positive("nope", "--max-spend")).toThrow(/must be a positive number/);
  });

  it("passes an absent option through untouched", () => {
    expect(positive(undefined, "--max-tokens")).toBeUndefined();
  });
});
