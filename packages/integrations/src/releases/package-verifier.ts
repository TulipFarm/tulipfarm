import {
  type OimManifest,
  type OimPackageContent,
  oimFileDigest,
  oimPackageDigest,
  oimPackageIssues,
  validateOimManifest,
} from "@tulipfarm/schema";
import { oimProviderContractIssues } from "./provider-validation";

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
  let manifest: OimManifest;
  try {
    manifest = validateOimManifest(packageInput.manifest);
  } catch (error) {
    throw new OimPackageVerificationError([
      `manifest: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const inputIssues: string[] = [];
  for (const [path, content] of packageInput.files) {
    const pathIssue = inputPathIssue(path);
    if (pathIssue !== undefined) inputIssues.push(pathIssue);
    if (typeof content !== "string" && !(content instanceof Uint8Array)) {
      inputIssues.push(`files: ${path} must contain string or byte content`);
    }
  }
  if (inputIssues.length > 0) throw new OimPackageVerificationError(inputIssues);

  const issues = oimPackageIssues(manifest, packageInput.files);
  if (issues.length > 0) throw new OimPackageVerificationError(issues);

  const providerIssues = oimProviderContractIssues(manifest, packageInput.files);
  if (providerIssues.length > 0) throw new OimPackageVerificationError(providerIssues);

  return Object.freeze({
    integrationId: manifest.metadata.id,
    version: manifest.metadata.version,
    packageDigest: oimPackageDigest(manifest),
    files: Object.freeze(
      (manifest.files ?? []).map((file) => {
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
