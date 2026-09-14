import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, type OimManifest, oimFileDigest, oimPackageDigest } from "@tulipfarm/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitActor, CommitSigner } from "../commit-signing";
import { SoulGitStore } from "../git-store";
import type { Logger } from "../types";
import { SoulWriter } from "../writer";
import {
  createOimSoulReleasePackageWriter,
  OimSoulReleasePackageError,
  type OimSoulReleasePackageSnapshot,
} from "./oim-release-package";

const ACTOR: CommitActor = {
  principalId: "user:installer",
  name: "Muskan Vijayvargiya",
  email: "muskan@example.com",
};
const signer: CommitSigner = {
  keyId: "test-key",
  sign: (payload) => createHmac("sha256", "test-secret").update(payload).digest("base64"),
};

let root: string;
let writer: SoulWriter;
let store: SoulGitStore;

async function currentArtifactRevision(slug: string): Promise<string | null> {
  try {
    return (
      execFileSync("git", ["log", "-1", "--format=%H", "--", `integrations/${slug}`], {
        cwd: root,
        encoding: "utf8",
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function packageWriter(
  publication: { ensurePublished(revision: string): Promise<void> } = {
    ensurePublished: async () => {},
  }
) {
  return createOimSoulReleasePackageWriter({
    soulWriter: writer,
    soulStore: store,
    currentArtifactRevision,
    publication,
    actor: ACTOR,
  });
}

function manifest(files: Readonly<Record<string, string>>): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "weather",
      name: "Weather",
      version: "1.2.3",
      description: "Read current weather.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    files: Object.entries(files).map(([path, content]) => ({
      path,
      role: path.endsWith(".md") ? ("guide" as const) : ("fixture" as const),
      sha256: oimFileDigest(content),
    })),
    operations: [
      {
        id: "current-weather",
        name: "current_weather",
        description: "Read current weather.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.weather.example",
          path: "/v1/current",
        },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
      },
    ],
  };
}

function snapshot(files: Readonly<Record<string, string>>): OimSoulReleasePackageSnapshot {
  const value = manifest(files);
  return {
    integrationId: "weather",
    version: "1.2.3",
    majorVersion: 1,
    packageDigest: oimPackageDigest(value),
    manifestText: canonicalize(value),
    files: Object.entries(files).map(([path, content]) => ({
      path,
      role: path.endsWith(".md") ? ("guide" as const) : ("fixture" as const),
      sha256: oimFileDigest(content),
      contentBase64: Buffer.from(content).toString("base64"),
    })),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".oim-soul-package-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "bot@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "bot"], { cwd: root });
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  store = new SoulGitStore(root, signer, logger);
  writer = new SoulWriter(store, logger, undefined, undefined, {
    publishCommittedTree: async () => undefined,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("OIM Soul release package writer", () => {
  it("replays a persisted write plan and rollback receipt after process restart", async () => {
    const first = packageWriter();
    const plan = await first.prepare({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: snapshot({ "setup-guide.md": "# Setup\n" }),
    });
    const receipt = await first.apply(plan);
    const commitCount = Number(
      execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    );

    const restarted = packageWriter();
    await expect(restarted.apply(JSON.parse(JSON.stringify(plan)))).resolves.toMatchObject({
      revision: receipt.revision,
    });
    expect(
      Number(
        execFileSync("git", ["rev-list", "--count", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim()
      )
    ).toBe(commitCount);
    await expect(restarted.rollback(JSON.parse(JSON.stringify(receipt)))).resolves.toMatchObject({
      revision: expect.any(String),
    });
    expect(store.listFiles("integrations/weather-v1")).toEqual([]);
  });

  it("publishes an already committed package before replay reports success", async () => {
    const plan = await packageWriter().prepare({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: snapshot({ "setup-guide.md": "# Setup\n" }),
    });
    const committed = await packageWriter().apply(plan);
    writeFileSync(join(root, "unrelated.txt"), "other change\n");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "soul: unrelated change"], { cwd: root });
    const currentTreeRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    expect(currentTreeRevision).not.toBe(committed.revision);
    let publicationFails = true;
    let activeRevision: string | null = null;
    const ensurePublished = vi.fn(async (revision: string) => {
      if (publicationFails) throw new Error("publication unavailable");
      activeRevision = revision;
    });
    const restarted = packageWriter({ ensurePublished });

    await expect(restarted.apply(JSON.parse(JSON.stringify(plan)))).rejects.toMatchObject({
      code: "PUBLICATION_FAILED",
    });
    expect(activeRevision).toBeNull();

    publicationFails = false;
    await expect(restarted.apply(JSON.parse(JSON.stringify(plan)))).resolves.toMatchObject({
      revision: committed.revision,
    });
    expect(activeRevision).toBe(currentTreeRevision);
    expect(ensurePublished).toHaveBeenCalledTimes(2);
    expect(ensurePublished).toHaveBeenNthCalledWith(1, currentTreeRevision);
    expect(ensurePublished).toHaveBeenNthCalledWith(2, currentTreeRevision);
  });

  it("revalidates and atomically writes only the reviewed package bytes", async () => {
    const packages = packageWriter();
    const reviewed = snapshot({ "setup-guide.md": "# Reviewed\n" });

    const receipt = await packages.install({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: reviewed,
    });

    expect(receipt.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(root, "integrations/weather-v1/oim.yml"), "utf8")).toBe(
      reviewed.manifestText
    );
    expect(readFileSync(join(root, "integrations/weather-v1/setup-guide.md"), "utf8")).toBe(
      "# Reviewed\n"
    );
  });

  it("rejects changed snapshot bytes before any Soul commit", async () => {
    const packages = packageWriter();
    const reviewed = snapshot({ "setup-guide.md": "# Reviewed\n" });
    const changed = {
      ...reviewed,
      files: [
        { ...reviewed.files[0], contentBase64: Buffer.from("# Changed\n").toString("base64") },
      ],
    };

    await expect(
      packages.install({
        businessId: "business-1",
        slug: "weather-v1",
        snapshot: changed,
      })
    ).rejects.toBeInstanceOf(OimSoulReleasePackageError);
    expect(execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" })).toBe("");
  });

  it("deletes stale companions and restores the exact previous package on rollback", async () => {
    const packages = packageWriter();
    await packages.install({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: snapshot({ "old.json": '{"version":1}\n' }),
    });
    const replacement = await packages.install({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: snapshot({ "new.json": '{"version":2}\n' }),
    });

    expect(() => readFileSync(join(root, "integrations/weather-v1/old.json"))).toThrow();
    const rollback = await packages.rollback(replacement);

    expect(readFileSync(join(root, "integrations/weather-v1/old.json"), "utf8")).toBe(
      '{"version":1}\n'
    );
    expect(() => readFileSync(join(root, "integrations/weather-v1/new.json"))).toThrow();
    await expect(
      packages.remove({
        businessId: "business-1",
        slug: "weather-v1",
        integrationId: "weather",
        majorVersion: 1,
        packageDigest: snapshot({ "old.json": '{"version":1}\n' }).packageDigest,
        soulRevision: rollback.revision,
      })
    ).resolves.toMatchObject({ alreadyAbsent: false });
  });

  it("rolls back after an unrelated Soul revision without overwriting another package", async () => {
    const packages = packageWriter();
    const first = await packages.install({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: snapshot({ "setup-guide.md": "# Weather\n" }),
    });
    const calendar = snapshot({ "setup-guide.md": "# Copy\n" });
    const calendarManifest = {
      ...JSON.parse(calendar.manifestText),
      metadata: {
        ...JSON.parse(calendar.manifestText).metadata,
        id: "calendar",
        version: "1.0.0",
      },
    };
    await packages.install({
      businessId: "business-1",
      slug: "calendar-v1",
      snapshot: {
        ...calendar,
        integrationId: "calendar",
        version: "1.0.0",
        packageDigest: oimPackageDigest(calendarManifest),
        manifestText: canonicalize(calendarManifest),
      },
    });

    await expect(packages.rollback(first)).resolves.toMatchObject({
      revision: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(() => readFileSync(join(root, "integrations/weather-v1/oim.yml"))).toThrow();
    expect(readFileSync(join(root, "integrations/calendar-v1/oim.yml"), "utf8")).toBe(
      canonicalize(calendarManifest)
    );
  });

  it("reports rollback publication failure instead of hiding an unconfirmed active bundle", async () => {
    let publications = 0;
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const publishingWriter = new SoulWriter(store, logger, undefined, undefined, {
      async publishCommittedTree() {
        publications += 1;
        if (publications === 2) throw new Error("publisher unavailable");
      },
    });
    let publishRetries = 0;
    const packages = createOimSoulReleasePackageWriter({
      soulWriter: publishingWriter,
      soulStore: store,
      currentArtifactRevision,
      publication: {
        async ensurePublished() {
          publishRetries += 1;
          if (publishRetries === 1) throw new Error("publisher still unavailable");
        },
      },
      actor: ACTOR,
    });
    const receipt = await packages.install({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: snapshot({ "setup-guide.md": "# Weather\n" }),
    });

    await expect(packages.rollback(receipt)).rejects.toMatchObject({
      code: "PUBLICATION_FAILED",
    });
    await expect(packages.rollback(receipt)).resolves.toMatchObject({
      revision: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(publishRetries).toBe(2);
  });

  it("surfaces the restored revision when replacement publication fails", async () => {
    let publications = 0;
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const publishingWriter = new SoulWriter(store, logger, undefined, undefined, {
      async publishCommittedTree() {
        publications += 1;
        if (publications === 2) throw new Error("replacement publication failed");
      },
    });
    const packages = createOimSoulReleasePackageWriter({
      soulWriter: publishingWriter,
      soulStore: store,
      currentArtifactRevision,
      publication: { ensurePublished: async () => {} },
      actor: ACTOR,
    });
    const original = snapshot({ "old.json": '{"version":1}\n' });
    await packages.install({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: original,
    });

    await expect(
      packages.install({
        businessId: "business-1",
        slug: "weather-v1",
        snapshot: snapshot({ "new.json": '{"version":2}\n' }),
      })
    ).rejects.toMatchObject({
      code: "PUBLICATION_FAILED",
      rollbackReceipt: {
        revision: expect.stringMatching(/^[0-9a-f]{40}$/),
        restored: {
          integrationId: "weather",
          version: "1.2.3",
          majorVersion: 1,
          packageDigest: original.packageDigest,
        },
      },
    });
  });

  it("refuses to preserve an undeclared file from an existing package", async () => {
    const packages = packageWriter();

    await packages.install({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: snapshot({ "setup-guide.md": "# Weather\n" }),
    });
    writeFileSync(join(root, "integrations/weather-v1/orphan.json"), "{}\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "test: add orphan"], { cwd: root });

    await expect(
      packages.install({
        businessId: "business-1",
        slug: "weather-v1",
        snapshot: snapshot({ "setup-guide.md": "# Updated\n" }),
      })
    ).rejects.toMatchObject({ code: "CURRENT_PACKAGE_INVALID" });
    expect(readFileSync(join(root, "integrations/weather-v1/orphan.json"), "utf8")).toBe("{}\n");
  });

  it("refuses to overwrite a slug owned by another Integration identity", async () => {
    const packages = packageWriter();

    await packages.install({
      businessId: "business-1",
      slug: "shared",
      snapshot: snapshot({ "setup-guide.md": "# Weather\n" }),
    });
    const calendar = snapshot({ "setup-guide.md": "# Calendar\n" });
    const calendarManifest = {
      ...JSON.parse(calendar.manifestText),
      metadata: {
        ...JSON.parse(calendar.manifestText).metadata,
        id: "calendar",
        version: "2.0.0",
      },
    };

    await expect(
      packages.install({
        businessId: "business-1",
        slug: "shared",
        snapshot: {
          ...calendar,
          integrationId: "calendar",
          version: "2.0.0",
          majorVersion: 2,
          packageDigest: oimPackageDigest(calendarManifest),
          manifestText: canonicalize(calendarManifest),
        },
      })
    ).rejects.toMatchObject({ code: "PACKAGE_LOCATION_CONFLICT" });
    expect(
      JSON.parse(readFileSync(join(root, "integrations/shared/oim.yml"), "utf8"))
    ).toMatchObject({
      metadata: { id: "weather", version: "1.2.3" },
    });
  });

  it("refuses to install the same Integration major at a second slug", async () => {
    const packages = packageWriter();
    const weather = snapshot({ "setup-guide.md": "# Weather\n" });
    await packages.install({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: weather,
    });

    await expect(
      packages.install({
        businessId: "business-1",
        slug: "weather-copy-v1",
        snapshot: weather,
      })
    ).rejects.toMatchObject({ code: "PACKAGE_LOCATION_CONFLICT" });
    expect(() =>
      readFileSync(join(root, "integrations/weather-copy-v1/oim.yml"), "utf8")
    ).toThrow();
  });

  it("stores portable nested paths inside the Integration package", async () => {
    const packages = packageWriter();

    await packages.install({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: snapshot({ "guides/setup.md": "# Nested\n" }),
    });

    expect(readFileSync(join(root, "integrations/weather-v1/guides/setup.md"), "utf8")).toBe(
      "# Nested\n"
    );
  });

  it("rejects a companion path that escapes the Integration package", async () => {
    const packages = packageWriter();

    await expect(
      packages.install({
        businessId: "business-1",
        slug: "weather-v1",
        snapshot: snapshot({ "../escape.md": "# Escape\n" }),
      })
    ).rejects.toMatchObject({ code: "INVALID_INSTALL_SNAPSHOT" });
    expect(() => readFileSync(join(root, "integrations/escape.md"), "utf8")).toThrow();
  });

  it("removes only a Soul package matching the exact Integration major", async () => {
    const packages = packageWriter();
    const installed = await packages.install({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: snapshot({ "setup-guide.md": "# Weather\n" }),
    });

    await expect(
      packages.remove({
        businessId: "business-1",
        slug: "weather-v1",
        integrationId: "weather",
        majorVersion: 2,
        packageDigest: snapshot({ "setup-guide.md": "# Weather\n" }).packageDigest,
        soulRevision: installed.revision,
      })
    ).rejects.toMatchObject({ code: "REMOVE_SCOPE_MISMATCH" });
    await expect(
      packages.remove({
        businessId: "business-1",
        slug: "weather-v1",
        integrationId: "weather",
        majorVersion: 1,
        packageDigest: snapshot({ "setup-guide.md": "# Weather\n" }).packageDigest,
        soulRevision: installed.revision,
      })
    ).resolves.toMatchObject({ revision: expect.stringMatching(/^[0-9a-f]{40}$/) });
    await expect(
      packages.remove({
        businessId: "business-1",
        slug: "weather-v1",
        integrationId: "weather",
        majorVersion: 1,
        packageDigest: snapshot({ "setup-guide.md": "# Weather\n" }).packageDigest,
        soulRevision: installed.revision,
      })
    ).resolves.toMatchObject({ alreadyAbsent: true });
    expect(() => readFileSync(join(root, "integrations/weather-v1/oim.yml"))).toThrow();
  });

  it("does not let an old installation generation remove a reinstall of the same bytes", async () => {
    const packages = packageWriter();
    const reviewed = snapshot({ "setup-guide.md": "# Weather\n" });
    const first = await packages.install({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: reviewed,
    });
    await packages.remove({
      businessId: "business-1",
      slug: "weather-v1",
      integrationId: "weather",
      majorVersion: 1,
      packageDigest: reviewed.packageDigest,
      soulRevision: first.revision,
    });
    const second = await packages.install({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: reviewed,
    });

    await expect(
      packages.remove({
        businessId: "business-1",
        slug: "weather-v1",
        integrationId: "weather",
        majorVersion: 1,
        packageDigest: reviewed.packageDigest,
        soulRevision: first.revision,
      })
    ).rejects.toMatchObject({ code: "REMOVE_SCOPE_MISMATCH" });
    expect(await currentArtifactRevision("weather-v1")).toBe(second.revision);
  });

  it("requires an absent package deletion revision to be published before retry completes", async () => {
    let failDeletionPublication = false;
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const deletionWriter = new SoulWriter(store, logger, undefined, undefined, {
      async publishCommittedTree() {
        if (failDeletionPublication) throw new Error("publisher unavailable");
      },
    });
    let publishRetries = 0;
    const packages = createOimSoulReleasePackageWriter({
      soulWriter: deletionWriter,
      soulStore: store,
      currentArtifactRevision,
      publication: {
        async ensurePublished() {
          publishRetries += 1;
          if (publishRetries === 1) throw new Error("publisher still unavailable");
        },
      },
      actor: ACTOR,
    });
    const reviewed = snapshot({ "setup-guide.md": "# Weather\n" });
    const installed = await packages.install({
      businessId: "business-1",
      slug: "weather-v1",
      snapshot: reviewed,
    });
    failDeletionPublication = true;
    const removeInput = {
      businessId: "business-1",
      slug: "weather-v1",
      integrationId: "weather",
      majorVersion: 1,
      packageDigest: reviewed.packageDigest,
      soulRevision: installed.revision,
    };

    await expect(packages.remove(removeInput)).rejects.toMatchObject({
      code: "PUBLICATION_FAILED",
    });
    await expect(packages.remove(removeInput)).resolves.toMatchObject({
      alreadyAbsent: true,
    });
    expect(publishRetries).toBe(2);
  });
});
