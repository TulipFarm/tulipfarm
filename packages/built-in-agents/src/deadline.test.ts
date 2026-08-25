import { describe, expect, it } from "vitest";
import { withDeadline } from "./deadline";

describe("withDeadline", () => {
  it("returns the work when it settles first", async () => {
    const controller = new AbortController();
    await expect(withDeadline(Promise.resolve("model"), controller.signal)).resolves.toBe("model");
  });

  it("stops waiting when the deadline wins", async () => {
    const signal = AbortSignal.timeout(1);
    // A model source that never settles: the failure this guards is a resolution that hangs, not
    // one that throws.
    await expect(withDeadline(new Promise(() => {}), signal)).rejects.toThrow();
  });

  it("rejects immediately on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(withDeadline(new Promise(() => {}), controller.signal)).rejects.toThrow("gone");
  });

  it("surfaces the work's own rejection unchanged", async () => {
    const controller = new AbortController();
    await expect(
      withDeadline(Promise.reject(new Error("no model configured")), controller.signal)
    ).rejects.toThrow("no model configured");
  });

  it("does not leave a late rejection unobserved", async () => {
    const signal = AbortSignal.timeout(1);
    let late!: (error: Error) => void;
    const work = new Promise<string>((_resolve, reject) => {
      late = reject;
    });
    await expect(withDeadline(work, signal)).rejects.toThrow();
    // Rejecting after the deadline already won would take the process down under Node's default
    // unhandled-rejection policy if `withDeadline` had not observed it.
    late(new Error("arrived too late"));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});
