import { beforeEach, expect, test, vi } from "vitest";
import { apiSend } from "./api";
import { completeSetup } from "./setup";

vi.mock("./api", () => ({ apiGet: vi.fn(), apiWrite: vi.fn(), apiSend: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

test.each([0, 1, 2] as const)(
  "sends the explicit level %s when completing setup",
  async (level) => {
    await completeSetup(level);
    expect(apiSend).toHaveBeenCalledExactlyOnceWith("POST", "/api/v1/setup/complete", {
      telemetryLevel: level,
    });
  }
);

test("defaults setup to level 2 when no level is provided", async () => {
  await completeSetup();
  expect(apiSend).toHaveBeenCalledExactlyOnceWith("POST", "/api/v1/setup/complete", {
    telemetryLevel: 2,
  });
});
