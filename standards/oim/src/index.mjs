import { lstat, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OIM_CONFORMANCE_CASES,
  OIM_CORE_PROFILE_VERSIONS,
  OIM_PROFILE_VERSIONS,
  OIM_VERSION,
  OimConformanceClaimSchema,
  OimFixtureSuiteSchema,
  OimManifestSchema,
  oimCompatibilityIssues,
  oimConformanceIssues,
  oimFileDigest,
  oimManifestIssues,
  oimPackageDigest,
  oimPackageIssues,
  oimToolId,
  parseOimFixtureSuite,
  parseOimManifest,
  validateOimConformanceClaim as validateClaimShape,
  validateOimFixtureSuite,
  validateOimManifest,
} from "../dist/oim-runtime.mjs";

export const OIM_ENTRYPOINT = "oim.yml";
export const OIM_PROFILE_VERSION_MATRIX = Object.freeze(
  Object.fromEntries(
    Object.keys(OIM_PROFILE_VERSIONS).map((profile) => {
      const versions = OimManifestSchema.properties.profiles.properties[profile].enum;
      if (!Array.isArray(versions) || versions.some((version) => typeof version !== "string")) {
        throw new Error(`generated OIM schema has no version enum for ${profile}`);
      }
      return [profile, Object.freeze([...versions])];
    })
  )
);

export {
  OIM_CONFORMANCE_CASES,
  OIM_CORE_PROFILE_VERSIONS,
  OIM_PROFILE_VERSIONS,
  OIM_VERSION,
  OimConformanceClaimSchema,
  OimFixtureSuiteSchema,
  OimManifestSchema,
  oimCompatibilityIssues,
  oimFileDigest,
  oimManifestIssues,
  oimPackageDigest,
  oimPackageIssues,
  oimToolId,
  validateOimFixtureSuite,
  validateOimManifest,
};

export class OimValidationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "OimValidationError";
  }
}

function normalizeError(error) {
  if (error instanceof OimValidationError) return error;
  return new OimValidationError(error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

export function validateManifestSource(source) {
  try {
    return parseOimManifest(source);
  } catch (error) {
    throw normalizeError(error);
  }
}

export function validateFixtureSuiteSource(source) {
  try {
    return parseOimFixtureSuite(source);
  } catch (error) {
    throw normalizeError(error);
  }
}

export function validateConformanceClaim(data) {
  try {
    const claim = validateClaimShape(data);
    const issues = oimConformanceIssues(claim);
    const allowedCases = new Set(
      Object.keys(claim.profiles).flatMap((profile) => OIM_CONFORMANCE_CASES[profile])
    );
    for (const caseId of claim.passedCases) {
      if (!allowedCases.has(caseId)) issues.push(`passedCases: ${caseId} is not claimed`);
    }
    if (issues.length > 0) throw new OimValidationError(issues.join("; "));
    return claim;
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function validatePackageDirectory(directory) {
  const root = resolve(directory instanceof URL ? fileURLToPath(directory) : directory);
  const entries = await collectFiles(root);
  if (!entries.has(OIM_ENTRYPOINT)) {
    throw new OimValidationError(`package entrypoint ${OIM_ENTRYPOINT} is missing`);
  }
  if (entries.has("manifest.yml")) {
    throw new OimValidationError(`manifest.yml is not allowed; use ${OIM_ENTRYPOINT}`);
  }

  const manifest = validateManifestSource(entries.get(OIM_ENTRYPOINT).toString("utf8"));
  entries.delete(OIM_ENTRYPOINT);
  const issues = oimPackageIssues(manifest, entries);
  if (issues.length > 0) throw new OimValidationError(issues.join("; "));
  return { manifest, digest: oimPackageDigest(manifest) };
}

async function collectFiles(root) {
  const files = new Map();
  await visit(root, "");
  return files;

  async function visit(directory, relativeDirectory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new OimValidationError(`files: ${relativePath} may not be a symbolic link`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.set(relativePath, await readFile(absolutePath));
      } else {
        throw new OimValidationError(`files: ${relativePath} is not a regular file`);
      }
    }
  }
}
