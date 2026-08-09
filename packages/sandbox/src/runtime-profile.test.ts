import { describe, expect, it } from "vitest";
import {
  type SandboxRuntimeProfileError,
  SandboxRuntimeProfileRegistry,
  shellTsPythonV1,
} from "./runtime-profile";

const digest = `sha256:${"a".repeat(64)}`;

describe("SandboxRuntimeProfileRegistry", () => {
  it("resolves the pinned shell, TypeScript, and Python profile", () => {
    const registry = new SandboxRuntimeProfileRegistry([shellTsPythonV1(digest)]);
    expect(registry.require("shell-ts-python-v1", ["curl", "python3"]).imageDigest).toBe(digest);
  });

  it("blocks a command that is not present in the pinned image", () => {
    const registry = new SandboxRuntimeProfileRegistry([shellTsPythonV1(digest)]);
    expect(() => registry.require("shell-ts-python-v1", ["gws"])).toThrow(
      expect.objectContaining<SandboxRuntimeProfileError>({
        code: "runtime_requirement_unavailable",
        profileId: "shell-ts-python-v1",
        requirement: "gws",
      })
    );
  });

  it("rejects mutable image tags", () => {
    expect(
      () =>
        new SandboxRuntimeProfileRegistry([
          {
            id: "bad",
            imageDigest: "latest",
            languages: ["shell"],
            commands: ["bash"],
          },
        ])
    ).toThrow(
      expect.objectContaining<SandboxRuntimeProfileError>({ code: "invalid_runtime_profile" })
    );
  });
});
