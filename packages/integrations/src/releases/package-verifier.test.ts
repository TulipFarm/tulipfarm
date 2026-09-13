import { oimFileDigest, oimPackageDigest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { verifyOimReleasePackage } from "./package-verifier";
import { releasePackageFixture } from "./test-fixtures";

describe("verifyOimReleasePackage", () => {
  it("records the exact validated companion byte digests", () => {
    const package_ = releasePackageFixture({
      files: {
        "setup-guide.md": "# Set up Weather\n",
        "fixtures.yml": "version: 1\n",
      },
    });

    expect(verifyOimReleasePackage(package_)).toEqual({
      integrationId: "weather",
      version: "1.2.3",
      packageDigest: oimPackageDigest(package_.manifest),
      files: [
        {
          path: "setup-guide.md",
          role: "guide",
          sha256: oimFileDigest("# Set up Weather\n"),
        },
        {
          path: "fixtures.yml",
          role: "fixture",
          sha256: oimFileDigest("version: 1\n"),
        },
      ],
    });
  });

  it("rejects tampered and missing declared companions", () => {
    const package_ = releasePackageFixture({
      files: { "setup-guide.md": "# Expected\n" },
    });

    expect(() =>
      verifyOimReleasePackage({
        ...package_,
        files: new Map([["setup-guide.md", "# Tampered\n"]]),
      })
    ).toThrow("setup-guide.md digest does not match the manifest");
    expect(() =>
      verifyOimReleasePackage({
        ...package_,
        files: new Map(),
      })
    ).toThrow("setup-guide.md is declared but missing");
  });

  it.each([
    { path: "setup-guide.md", role: "guide" as const, content: "# Guide\n" },
    { path: "hooks/normalize.js", role: "hook" as const, content: "export const run = () => 1;\n" },
    { path: "data/provider.json", role: "fixture" as const, content: '{"version":1}\n' },
  ])("rejects missing declared $role companion bytes", ({ path, role, content }) => {
    const package_ = releasePackageFixture();
    package_.manifest.files = [{ path, role, sha256: oimFileDigest(content) }];

    expect(() => verifyOimReleasePackage(package_)).toThrow(`${path} is declared but missing`);
  });

  it.each(["setup-guide.md", "hooks/normalize.js", "data/provider.json"])(
    "rejects undeclared installation companion %s",
    (path) => {
      const package_ = releasePackageFixture();

      expect(() =>
        verifyOimReleasePackage({
          ...package_,
          files: new Map([[path, "undeclared bytes"]]),
        })
      ).toThrow(`${path} is present but not declared`);
    }
  );

  it.each(["/setup-guide.md", "./setup-guide.md", "docs/../setup-guide.md", "docs//guide.md"])(
    "rejects path alias %s before it can enter the byte map",
    (path) => {
      expect(() =>
        verifyOimReleasePackage({
          ...releasePackageFixture(),
          files: new Map([[path, "# Guide\n"]]),
        })
      ).toThrow("is not an exact portable companion path");
    }
  );

  it("digests exact binary bytes rather than a decoded representation", () => {
    const bytes = new TextEncoder().encode('{"version":1}\n');
    const package_ = releasePackageFixture({
      files: { "fixtures.json": bytes },
    });

    expect(verifyOimReleasePackage(package_).files).toEqual([
      {
        path: "fixtures.json",
        role: "fixture",
        sha256: oimFileDigest(bytes),
      },
    ]);
    expect(() =>
      verifyOimReleasePackage({
        ...package_,
        files: new Map([["fixtures.json", new TextEncoder().encode('{"version":2}\n')]]),
      })
    ).toThrow("fixtures.json digest does not match the manifest");
  });
});
