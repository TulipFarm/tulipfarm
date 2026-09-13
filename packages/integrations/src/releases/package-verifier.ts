import {
  type OimManifest,
  type OimPackageContent,
  oimFileDigest,
  oimPackageDigest,
  oimPackageIssues,
} from "@tulipfarm/schema";

export interface OimReleasePackage {
  readonly manifest: OimManifest;
  readonly files: ReadonlyMap<string, OimPackageContent>;
}

export interface VerifiedOimPackageFile {
  readonly path: string;
  readonly role: NonNullable<OimManifest["files"]>[number]["role"];
  readonly sha256: string;
}

export interface VerifiedOimReleasePackage {
  readonly integrationId: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly files: readonly VerifiedOimPackageFile[];
}

export class OimPackageVerificationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`OIM package is invalid: ${issues.join("; ")}`);
    this.name = "OimPackageVerificationError";
  }
}

function inputPathIssue(path: string): string | undefined {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return `files: ${path || "<empty>"} is not an exact portable companion path`;
  }
  return undefined;
}

export function verifyOimReleasePackage(
  packageInput: OimReleasePackage
): VerifiedOimReleasePackage {
  const inputIssues: string[] = [];
  for (const [path, content] of packageInput.files) {
    const pathIssue = inputPathIssue(path);
    if (pathIssue !== undefined) inputIssues.push(pathIssue);
    if (typeof content !== "string" && !(content instanceof Uint8Array)) {
      inputIssues.push(`files: ${path} must contain string or byte content`);
    }
  }
  if (inputIssues.length > 0) throw new OimPackageVerificationError(inputIssues);

  const issues = oimPackageIssues(packageInput.manifest, packageInput.files);
  if (issues.length > 0) throw new OimPackageVerificationError(issues);

  return Object.freeze({
    integrationId: packageInput.manifest.metadata.id,
    version: packageInput.manifest.metadata.version,
    packageDigest: oimPackageDigest(packageInput.manifest),
    files: Object.freeze(
      (packageInput.manifest.files ?? []).map((file) => {
        const content = packageInput.files.get(file.path);
        if (content === undefined) {
          throw new OimPackageVerificationError([`files: ${file.path} is declared but missing`]);
        }
        return Object.freeze({
          path: file.path,
          role: file.role,
          sha256: oimFileDigest(content),
        });
      })
    ),
  });
}
