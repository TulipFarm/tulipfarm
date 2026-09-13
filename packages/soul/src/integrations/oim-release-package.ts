import {
  artifactDirectory,
  canonicalize,
  type OimManifest,
  type OimPackageContent,
  oimFileDigest,
  oimPackageDigest,
  oimPackageIssues,
  parseOimManifest,
  unstorableArtifactPaths,
} from "@tulipfarm/schema";
import type { CommitActor } from "../commit-signing";
import type { SoulGitStore } from "../git-store";
import type { SoulWrite, SoulWriter } from "../writer";

export interface OimSoulReleasePackageSnapshotFile {
  readonly path: string;
  readonly role: NonNullable<OimManifest["files"]>[number]["role"];
  readonly sha256: string;
  readonly contentBase64: string;
}

export interface OimSoulReleasePackageSnapshot {
  readonly integrationId: string;
  readonly version: string;
  readonly majorVersion: number;
  readonly packageDigest: string;
  readonly manifestText: string;
  readonly files: readonly OimSoulReleasePackageSnapshotFile[];
}

interface PreviousOimSoulPackage {
  readonly manifestText: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface OimSoulReleasePackageWritePlan {
  readonly businessId: string;
  readonly slug: string;
  readonly snapshot: OimSoulReleasePackageSnapshot;
  readonly expectedBaseCommit: string;
  readonly previous: PreviousOimSoulPackage | null;
}

interface OimSoulRollbackToken {
  readonly businessId: string;
  readonly slug: string;
  readonly installedRevision: string;
  readonly installedPackageDigest: string;
  readonly installedPaths: readonly string[];
  readonly previous: PreviousOimSoulPackage | null;
}

export interface OimSoulReleasePackageReceipt {
  readonly revision: string;
  readonly rollbackToken: unknown;
}

export interface OimSoulReleaseRollbackReceipt {
  readonly revision: string;
  readonly restored?: {
    readonly integrationId: string;
    readonly version: string;
    readonly majorVersion: number;
    readonly packageDigest: string;
  };
}

export type OimSoulArtifactRevisionPort = (slug: string) => Promise<string | null>;

export interface OimSoulReleasePublicationPort {
  ensurePublished(revision: string): Promise<void>;
}

export class OimSoulReleasePackageError extends Error {
  constructor(
    readonly code:
      | "AMBIGUOUS_EXISTING_PACKAGE"
      | "CURRENT_PACKAGE_INVALID"
      | "INVALID_INSTALL_SNAPSHOT"
      | "PACKAGE_LOCATION_CONFLICT"
      | "PUBLICATION_FAILED"
      | "REMOVE_SCOPE_MISMATCH"
      | "ROLLBACK_CONFLICT"
      | "ROLLBACK_TOKEN_INVALID"
      | "UNSTORABLE_PACKAGE_PATH",
    message: string,
    readonly rollbackReceipt?: OimSoulReleaseRollbackReceipt
  ) {
    super(message);
    this.name = "OimSoulReleasePackageError";
  }
}

function decodeBase64(value: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new OimSoulReleasePackageError(
      "INVALID_INSTALL_SNAPSHOT",
      "OIM companion snapshot is not canonical base64"
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new OimSoulReleasePackageError(
      "INVALID_INSTALL_SNAPSHOT",
      "OIM companion snapshot is not canonical base64"
    );
  }
  return new Uint8Array(bytes);
}

function decodeText(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OimSoulReleasePackageError(
      "INVALID_INSTALL_SNAPSHOT",
      `OIM companion ${path} is not UTF-8 text`
    );
  }
}

function revalidateSnapshot(snapshot: OimSoulReleasePackageSnapshot): {
  readonly manifest: OimManifest;
  readonly manifestText: string;
  readonly files: ReadonlyMap<string, OimPackageContent>;
  readonly textFiles: ReadonlyMap<string, string>;
} {
  let manifest: OimManifest;
  try {
    manifest = parseOimManifest(snapshot.manifestText);
  } catch {
    throw new OimSoulReleasePackageError(
      "INVALID_INSTALL_SNAPSHOT",
      "OIM install snapshot contains an invalid manifest"
    );
  }
  if (
    snapshot.manifestText !== canonicalize(manifest) ||
    manifest.metadata.id !== snapshot.integrationId ||
    manifest.metadata.version !== snapshot.version ||
    Number(snapshot.version.split(".")[0]) !== snapshot.majorVersion ||
    oimPackageDigest(manifest) !== snapshot.packageDigest
  ) {
    throw new OimSoulReleasePackageError(
      "INVALID_INSTALL_SNAPSHOT",
      "OIM install snapshot identity does not match its manifest"
    );
  }

  const declared = new Map((manifest.files ?? []).map((file) => [file.path, file]));
  const files = new Map<string, OimPackageContent>();
  const textFiles = new Map<string, string>();
  for (const file of snapshot.files) {
    if (files.has(file.path)) {
      throw new OimSoulReleasePackageError(
        "INVALID_INSTALL_SNAPSHOT",
        `OIM install snapshot repeats ${file.path}`
      );
    }
    const declaration = declared.get(file.path);
    const bytes = decodeBase64(file.contentBase64);
    if (
      declaration === undefined ||
      declaration.role !== file.role ||
      declaration.sha256 !== file.sha256 ||
      oimFileDigest(bytes) !== file.sha256
    ) {
      throw new OimSoulReleasePackageError(
        "INVALID_INSTALL_SNAPSHOT",
        `OIM companion ${file.path} does not match its reviewed declaration`
      );
    }
    files.set(file.path, bytes);
    textFiles.set(file.path, decodeText(bytes, file.path));
  }
  const issues = oimPackageIssues(manifest, files);
  if (issues.length > 0) {
    throw new OimSoulReleasePackageError(
      "INVALID_INSTALL_SNAPSHOT",
      `OIM install snapshot is invalid: ${issues.join("; ")}`
    );
  }
  return { manifest, manifestText: snapshot.manifestText, files, textFiles };
}

function readPreviousPackage(
  soulWriter: SoulWriter,
  slug: string,
  manifestText: string | null
): PreviousOimSoulPackage | null {
  if (manifestText === null) return null;
  let manifest: OimManifest;
  try {
    manifest = parseOimManifest(manifestText);
  } catch {
    throw new OimSoulReleasePackageError(
      "CURRENT_PACKAGE_INVALID",
      "Installed OIM package manifest is invalid"
    );
  }
  if (manifestText !== canonicalize(manifest)) {
    throw new OimSoulReleasePackageError(
      "CURRENT_PACKAGE_INVALID",
      "Installed OIM package manifest is not canonical"
    );
  }
  const files: Record<string, string> = {};
  for (const file of manifest.files ?? []) {
    const content = soulWriter.readCompanion("Integration", slug, file.path);
    if (content === null || oimFileDigest(content) !== file.sha256) {
      throw new OimSoulReleasePackageError(
        "CURRENT_PACKAGE_INVALID",
        `Installed OIM companion ${file.path} is missing or changed`
      );
    }
    files[file.path] = content;
  }
  if (oimPackageIssues(manifest, new Map(Object.entries(files))).length > 0) {
    throw new OimSoulReleasePackageError(
      "CURRENT_PACKAGE_INVALID",
      "Installed OIM package is not internally consistent"
    );
  }
  return Object.freeze({ manifestText, files: Object.freeze(files) });
}

function rollbackReceipt(
  revision: string,
  previous: PreviousOimSoulPackage | null
): OimSoulReleaseRollbackReceipt {
  if (previous === null) return { revision };
  const manifest = parseOimManifest(previous.manifestText);
  return {
    revision,
    restored: {
      integrationId: manifest.metadata.id,
      version: manifest.metadata.version,
      majorVersion: Number(manifest.metadata.version.split(".")[0]),
      packageDigest: oimPackageDigest(manifest),
    },
  };
}

export function createOimSoulReleasePackageWriter(input: {
  readonly soulWriter: SoulWriter;
  readonly soulStore: Pick<SoulGitStore, "listFiles">;
  /** Returns the last commit that changed this Integration artifact, not repository HEAD. */
  readonly currentArtifactRevision: OimSoulArtifactRevisionPort;
  readonly publication: OimSoulReleasePublicationPort;
  readonly actor: CommitActor;
}) {
  function installedPaths(slug: string): readonly string[] {
    const directory = artifactDirectory("Integration", slug);
    const prefix = `${directory}/`;
    return input.soulStore
      .listFiles(directory)
      .map((path) => path.slice(prefix.length))
      .sort();
  }

  async function assertLocationAvailable(
    slug: string,
    snapshot: OimSoulReleasePackageSnapshot
  ): Promise<void> {
    const otherSlugs = input.soulStore.listFiles("integrations").flatMap((path) => {
      const match = /^integrations\/([^/]+)\/oim\.yml$/.exec(path);
      return match?.[1] === undefined || match[1] === slug ? [] : [match[1]];
    });
    for (const otherSlug of otherSlugs) {
      const existing = await input.soulWriter.readCompanionWithBase(
        "Integration",
        otherSlug,
        "oim.yml"
      );
      if (existing.content === null) continue;
      let manifest: OimManifest;
      try {
        manifest = parseOimManifest(existing.content);
      } catch {
        throw new OimSoulReleasePackageError(
          "AMBIGUOUS_EXISTING_PACKAGE",
          `Cannot verify ownership of existing OIM package ${otherSlug}`
        );
      }
      if (
        manifest.metadata.id === snapshot.integrationId &&
        Number(manifest.metadata.version.split(".")[0]) === snapshot.majorVersion
      ) {
        throw new OimSoulReleasePackageError(
          "PACKAGE_LOCATION_CONFLICT",
          `Integration ${snapshot.integrationId} major ${snapshot.majorVersion} is installed at another slug`
        );
      }
    }
  }

  async function rollback(
    receipt: OimSoulReleasePackageReceipt
  ): Promise<OimSoulReleaseRollbackReceipt> {
    if (
      typeof receipt.rollbackToken !== "object" ||
      receipt.rollbackToken === null ||
      !("businessId" in receipt.rollbackToken) ||
      typeof receipt.rollbackToken.businessId !== "string" ||
      !("slug" in receipt.rollbackToken) ||
      typeof receipt.rollbackToken.slug !== "string" ||
      !("installedRevision" in receipt.rollbackToken) ||
      typeof receipt.rollbackToken.installedRevision !== "string" ||
      !("installedPackageDigest" in receipt.rollbackToken) ||
      typeof receipt.rollbackToken.installedPackageDigest !== "string" ||
      !("installedPaths" in receipt.rollbackToken) ||
      !Array.isArray(receipt.rollbackToken.installedPaths) ||
      !receipt.rollbackToken.installedPaths.every((path) => typeof path === "string") ||
      !("previous" in receipt.rollbackToken)
    ) {
      throw new OimSoulReleasePackageError(
        "ROLLBACK_TOKEN_INVALID",
        "OIM package rollback token was not issued by this writer"
      );
    }
    const token = receipt.rollbackToken as OimSoulRollbackToken;
    const current = await input.soulWriter.readCompanionWithBase(
      "Integration",
      token.slug,
      "oim.yml"
    );
    if (current.content === null) {
      if (token.previous === null) {
        await input.publication.ensurePublished(current.baseCommit);
        return rollbackReceipt(current.baseCommit, null);
      }
      throw new OimSoulReleasePackageError(
        "ROLLBACK_CONFLICT",
        "Installed OIM package changed before rollback"
      );
    }
    let installed: PreviousOimSoulPackage;
    try {
      const package_ = readPreviousPackage(input.soulWriter, token.slug, current.content);
      if (package_ === null) throw new Error("installed_oim_package_missing");
      installed = package_;
    } catch {
      throw new OimSoulReleasePackageError(
        "ROLLBACK_CONFLICT",
        "Installed OIM package changed before rollback"
      );
    }
    const manifest = parseOimManifest(installed.manifestText);
    if (token.previous !== null) {
      const previousPaths = ["oim.yml", ...Object.keys(token.previous.files)].sort();
      const currentPaths = ["oim.yml", ...Object.keys(installed.files)].sort();
      if (
        installed.manifestText === token.previous.manifestText &&
        JSON.stringify(installed.files) === JSON.stringify(token.previous.files) &&
        JSON.stringify(currentPaths) === JSON.stringify(previousPaths)
      ) {
        const artifactRevision = await input.currentArtifactRevision(token.slug);
        if (artifactRevision === null) {
          throw new OimSoulReleasePackageError(
            "ROLLBACK_CONFLICT",
            "Restored OIM package has no artifact revision"
          );
        }
        await input.publication.ensurePublished(current.baseCommit);
        return rollbackReceipt(artifactRevision, token.previous);
      }
    }
    if ((await input.currentArtifactRevision(token.slug)) !== token.installedRevision) {
      throw new OimSoulReleasePackageError(
        "ROLLBACK_CONFLICT",
        "Installed OIM package changed before rollback"
      );
    }
    const declaredPaths = ["oim.yml", ...Object.keys(installed.files)].sort();
    if (
      oimPackageDigest(manifest) !== token.installedPackageDigest ||
      JSON.stringify(declaredPaths) !== JSON.stringify([...token.installedPaths].sort()) ||
      installedPaths(token.slug).some((path) => !declaredPaths.includes(path))
    ) {
      throw new OimSoulReleasePackageError(
        "ROLLBACK_CONFLICT",
        "Installed OIM package changed before rollback"
      );
    }

    const previous = token.previous;
    const changes: SoulWrite[] =
      previous === null
        ? [{ op: "deleteArtifact", kind: "Integration", slug: token.slug }]
        : [
            ...token.installedPaths
              .filter((path) => path !== "oim.yml" && !(path in previous.files))
              .map(
                (path): SoulWrite => ({
                  op: "delete",
                  target: { kind: "Integration", slug: token.slug, companion: path },
                })
              ),
            {
              op: "put",
              target: { kind: "Integration", slug: token.slug, companion: "oim.yml" },
              content: previous.manifestText,
            },
            ...Object.entries(previous.files).map(
              ([path, content]): SoulWrite => ({
                op: "put",
                target: { kind: "Integration", slug: token.slug, companion: path },
                content,
              })
            ),
          ];
    const result = await input.soulWriter.apply({
      subject: `soul: roll back OIM integration ${token.slug}`,
      source: "api",
      actor: input.actor,
      businessId: token.businessId,
      changes,
      expectedBaseCommit: current.baseCommit,
    });
    if (!result.published) {
      try {
        await input.publication.ensurePublished(result.commitSha);
      } catch (error) {
        throw new OimSoulReleasePackageError(
          "PUBLICATION_FAILED",
          error instanceof Error
            ? error.message
            : (result.publicationError ?? "OIM package rollback publication failed")
        );
      }
    }
    return rollbackReceipt(result.commitSha, token.previous);
  }

  return Object.freeze({
    async prepare(installInput: {
      readonly businessId: string;
      readonly slug: string;
      readonly snapshot: OimSoulReleasePackageSnapshot;
    }): Promise<OimSoulReleasePackageWritePlan> {
      revalidateSnapshot(installInput.snapshot);
      const paths = ["oim.yml", ...installInput.snapshot.files.map(({ path }) => path)];
      const unstorable = unstorableArtifactPaths("Integration", installInput.slug, paths);
      if (unstorable.length > 0) {
        throw new OimSoulReleasePackageError(
          "UNSTORABLE_PACKAGE_PATH",
          `Soul cannot store OIM package paths: ${unstorable.join(", ")}`
        );
      }
      await assertLocationAvailable(installInput.slug, installInput.snapshot);
      const current = await input.soulWriter.readCompanionWithBase(
        "Integration",
        installInput.slug,
        "oim.yml"
      );
      const existingPaths = installedPaths(installInput.slug);
      if (current.content === null && existingPaths.length > 0) {
        throw new OimSoulReleasePackageError(
          "AMBIGUOUS_EXISTING_PACKAGE",
          "The Integration slug is already owned by a non-OIM package"
        );
      }
      const previous = readPreviousPackage(input.soulWriter, installInput.slug, current.content);
      if (previous !== null) {
        const previousManifest = parseOimManifest(previous.manifestText);
        if (
          previousManifest.metadata.id !== installInput.snapshot.integrationId ||
          Number(previousManifest.metadata.version.split(".")[0]) !==
            installInput.snapshot.majorVersion
        ) {
          throw new OimSoulReleasePackageError(
            "PACKAGE_LOCATION_CONFLICT",
            "The Integration slug is owned by another Integration identity"
          );
        }
        const declaredPaths = new Set(["oim.yml", ...Object.keys(previous.files)]);
        const undeclaredPaths = existingPaths.filter((path) => !declaredPaths.has(path));
        if (undeclaredPaths.length > 0) {
          throw new OimSoulReleasePackageError(
            "CURRENT_PACKAGE_INVALID",
            `Installed OIM package contains undeclared files: ${undeclaredPaths.join(", ")}`
          );
        }
      }
      return Object.freeze({
        businessId: installInput.businessId,
        slug: installInput.slug,
        snapshot: installInput.snapshot,
        expectedBaseCommit: current.baseCommit,
        previous,
      });
    },
    async apply(plan: OimSoulReleasePackageWritePlan): Promise<OimSoulReleasePackageReceipt> {
      const { manifestText, textFiles } = revalidateSnapshot(plan.snapshot);
      const current = await input.soulWriter.readCompanionWithBase(
        "Integration",
        plan.slug,
        "oim.yml"
      );
      if (current.baseCommit !== plan.expectedBaseCommit) {
        const installed = readPreviousPackage(input.soulWriter, plan.slug, current.content);
        const plannedFiles = Object.fromEntries(textFiles);
        if (
          installed === null ||
          installed.manifestText !== manifestText ||
          JSON.stringify(installed.files) !== JSON.stringify(plannedFiles)
        ) {
          throw new OimSoulReleasePackageError(
            "ROLLBACK_CONFLICT",
            "OIM package location changed after its durable write plan was recorded"
          );
        }
        const revision = await input.currentArtifactRevision(plan.slug);
        if (revision === null) {
          throw new OimSoulReleasePackageError(
            "ROLLBACK_CONFLICT",
            "Installed OIM package has no artifact revision"
          );
        }
        return Object.freeze({
          revision,
          rollbackToken: Object.freeze({
            businessId: plan.businessId,
            slug: plan.slug,
            installedRevision: revision,
            installedPackageDigest: plan.snapshot.packageDigest,
            installedPaths: Object.freeze(["oim.yml", ...textFiles.keys()]),
            previous: plan.previous,
          }),
        });
      }
      const currentPrevious = readPreviousPackage(input.soulWriter, plan.slug, current.content);
      if (JSON.stringify(currentPrevious) !== JSON.stringify(plan.previous)) {
        throw new OimSoulReleasePackageError(
          "ROLLBACK_CONFLICT",
          "OIM package location changed after its durable write plan was recorded"
        );
      }
      const installInput = {
        businessId: plan.businessId,
        slug: plan.slug,
        snapshot: plan.snapshot,
      };
      const paths = ["oim.yml", ...textFiles.keys()];
      const unstorable = unstorableArtifactPaths("Integration", installInput.slug, paths);
      if (unstorable.length > 0) {
        throw new OimSoulReleasePackageError(
          "UNSTORABLE_PACKAGE_PATH",
          `Soul cannot store OIM package paths: ${unstorable.join(", ")}`
        );
      }

      const previous = plan.previous;
      const previousPaths = new Set(Object.keys(previous?.files ?? {}));
      const nextPaths = new Set(textFiles.keys());
      const changes: SoulWrite[] = [
        ...[...previousPaths]
          .filter((path) => !nextPaths.has(path))
          .map(
            (path): SoulWrite => ({
              op: "delete",
              target: { kind: "Integration", slug: installInput.slug, companion: path },
            })
          ),
        {
          op: "put",
          target: { kind: "Integration", slug: installInput.slug, companion: "oim.yml" },
          content: manifestText,
        },
        ...[...textFiles].map(
          ([path, content]): SoulWrite => ({
            op: "put",
            target: { kind: "Integration", slug: installInput.slug, companion: path },
            content,
          })
        ),
      ];
      const result = await input.soulWriter.apply({
        subject: `soul: install OIM integration ${installInput.slug}`,
        source: "api",
        actor: input.actor,
        businessId: installInput.businessId,
        changes,
        expectedBaseCommit: plan.expectedBaseCommit,
      });
      const rollbackToken: OimSoulRollbackToken = Object.freeze({
        businessId: installInput.businessId,
        slug: installInput.slug,
        installedRevision: result.commitSha,
        installedPackageDigest: installInput.snapshot.packageDigest,
        installedPaths: Object.freeze(paths),
        previous,
      });
      const receipt = Object.freeze({
        revision: result.commitSha,
        rollbackToken,
      });
      if (!result.published) {
        const rollbackReceipt = await rollback(receipt);
        throw new OimSoulReleasePackageError(
          "PUBLICATION_FAILED",
          result.publicationError ?? "OIM package publication failed",
          rollbackReceipt
        );
      }
      return receipt;
    },
    async install(installInput: {
      readonly businessId: string;
      readonly slug: string;
      readonly snapshot: OimSoulReleasePackageSnapshot;
    }): Promise<OimSoulReleasePackageReceipt> {
      return this.apply(await this.prepare(installInput));
    },
    async remove(removeInput: {
      readonly businessId: string;
      readonly slug: string;
      readonly integrationId: string;
      readonly majorVersion: number;
      readonly packageDigest: string;
      readonly soulRevision: string;
    }): Promise<{ readonly revision: string; readonly alreadyAbsent: boolean }> {
      const current = await input.soulWriter.readCompanionWithBase(
        "Integration",
        removeInput.slug,
        "oim.yml"
      );
      if (current.content === null) {
        await input.publication.ensurePublished(current.baseCommit);
        return { revision: current.baseCommit, alreadyAbsent: true };
      }
      if ((await input.currentArtifactRevision(removeInput.slug)) !== removeInput.soulRevision) {
        throw new OimSoulReleasePackageError(
          "REMOVE_SCOPE_MISMATCH",
          "Installed OIM package belongs to another installation generation"
        );
      }
      let installed: PreviousOimSoulPackage;
      try {
        const package_ = readPreviousPackage(input.soulWriter, removeInput.slug, current.content);
        if (package_ === null) throw new Error("installed_oim_package_missing");
        installed = package_;
      } catch {
        throw new OimSoulReleasePackageError(
          "CURRENT_PACKAGE_INVALID",
          "Installed OIM package is invalid"
        );
      }
      const manifest = parseOimManifest(installed.manifestText);
      const declaredPaths = new Set(["oim.yml", ...Object.keys(installed.files)]);
      if (installedPaths(removeInput.slug).some((path) => !declaredPaths.has(path))) {
        throw new OimSoulReleasePackageError(
          "CURRENT_PACKAGE_INVALID",
          "Installed OIM package contains undeclared files"
        );
      }
      if (
        manifest.metadata.id !== removeInput.integrationId ||
        Number(manifest.metadata.version.split(".")[0]) !== removeInput.majorVersion ||
        oimPackageDigest(manifest) !== removeInput.packageDigest
      ) {
        throw new OimSoulReleasePackageError(
          "REMOVE_SCOPE_MISMATCH",
          "Installed OIM package does not match the exact uninstall scope"
        );
      }
      const result = await input.soulWriter.apply({
        subject: `soul: uninstall OIM integration ${removeInput.slug}`,
        source: "api",
        actor: input.actor,
        businessId: removeInput.businessId,
        changes: [{ op: "deleteArtifact", kind: "Integration", slug: removeInput.slug }],
        expectedBaseCommit: current.baseCommit,
      });
      if (!result.published) {
        try {
          await input.publication.ensurePublished(result.commitSha);
        } catch (error) {
          throw new OimSoulReleasePackageError(
            "PUBLICATION_FAILED",
            error instanceof Error
              ? error.message
              : (result.publicationError ?? "OIM package removal publication failed")
          );
        }
      }
      return { revision: result.commitSha, alreadyAbsent: false };
    },
    rollback,
  });
}
