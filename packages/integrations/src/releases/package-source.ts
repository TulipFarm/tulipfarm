import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { parseOimManifest } from "@tulipfarm/schema";
import { withGitSourceClone } from "../git-source";
import type { OimReleaseCandidate } from "./candidates";

const MAX_PACKAGE_DEPTH = 12;
const MAX_PACKAGE_FILES = 1024;
const MAX_SOURCE_ENTRIES = 10_000;
const MAX_SOURCE_PACKAGES = 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;

export interface InspectedOimReleaseCandidate extends OimReleaseCandidate {
  readonly sourcePath: string;
  readonly sourceIssues: readonly string[];
}

async function readRegularFile(path: string, label: string): Promise<Uint8Array> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new Error(`Unsafe OIM file: ${label}`);
  });
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`Unsafe OIM file: ${label}`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`OIM file is too large: ${label}`);
    const bytes = new Uint8Array(await file.readFile());
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`OIM file is too large: ${label}`);
    return bytes;
  } finally {
    await file.close();
  }
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function packageDirectories(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  let visitedEntries = 0;

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_PACKAGE_DEPTH) return;
    const entries = await readdir(directory, { withFileTypes: true });
    visitedEntries += entries.length;
    if (visitedEntries > MAX_SOURCE_ENTRIES) throw new Error("OIM source contains too many files");
    if (entries.some((entry) => entry.name === "oim.yml" && entry.isFile())) {
      found.push(directory);
      if (found.length > MAX_SOURCE_PACKAGES) {
        throw new Error("OIM source contains too many packages");
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
      await walk(resolve(directory, entry.name), depth + 1);
    }
  }

  await walk(resolve(root), 0);
  return found.sort((left, right) =>
    portableRelative(root, left).localeCompare(portableRelative(root, right))
  );
}

async function inspectPackage(
  root: string,
  directory: string
): Promise<InspectedOimReleaseCandidate> {
  const manifestPath = resolve(directory, "oim.yml");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error(`Unsafe OIM entry point: ${portableRelative(root, manifestPath)}`);
  }
  const manifestBytes = await readRegularFile(manifestPath, portableRelative(root, manifestPath));
  const manifest = parseOimManifest(
    new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)
  );
  const files = new Map<string, Uint8Array>();
  const sourceIssues: string[] = [];
  let totalBytes = manifestBytes.byteLength;

  async function collect(current: string, depth: number): Promise<void> {
    if (depth > MAX_PACKAGE_DEPTH) {
      sourceIssues.push(`${portableRelative(directory, current)} exceeds package depth`);
      return;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = resolve(current, entry.name);
      const path = portableRelative(directory, full);
      if (path === "oim.yml") continue;
      if (entry.isSymbolicLink()) {
        sourceIssues.push(`${path} is a symbolic link`);
        continue;
      }
      if (entry.isDirectory()) {
        await collect(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        sourceIssues.push(`${path} is not a regular file`);
        continue;
      }
      if (files.size >= MAX_PACKAGE_FILES) {
        sourceIssues.push(`package exceeds ${MAX_PACKAGE_FILES} companion files`);
        continue;
      }
      const info = await lstat(full);
      if (!info.isFile() || info.isSymbolicLink()) {
        sourceIssues.push(`${path} is not a regular file`);
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        sourceIssues.push(`${path} exceeds ${MAX_FILE_BYTES} bytes`);
        continue;
      }
      if (totalBytes > MAX_PACKAGE_BYTES || totalBytes + info.size > MAX_PACKAGE_BYTES) {
        sourceIssues.push(`package exceeds ${MAX_PACKAGE_BYTES} bytes`);
        totalBytes = MAX_PACKAGE_BYTES + 1;
        continue;
      }
      const bytes = await readRegularFile(full, path);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_PACKAGE_BYTES) {
        sourceIssues.push(`package exceeds ${MAX_PACKAGE_BYTES} bytes`);
        continue;
      }
      files.set(path, bytes);
    }
  }

  await collect(directory, 0);
  return Object.freeze({
    sourcePath: portableRelative(root, directory) || ".",
    package: { manifest, files },
    sourceIssues: Object.freeze(sourceIssues),
  });
}

export async function inspectOimReleasePackages(
  root: string
): Promise<readonly InspectedOimReleaseCandidate[]> {
  const directories = await packageDirectories(root);
  const inspected = await Promise.allSettled(
    directories.map((directory) => inspectPackage(root, directory))
  );
  return inspected.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

export async function inspectGitOimReleasePackages(
  source: string,
  actorId: string
): Promise<{
  readonly ref: string;
  readonly candidates: readonly InspectedOimReleaseCandidate[];
}> {
  return withGitSourceClone(source, { prefix: "oim-release-", actorId }, async ({ dir, ref }) => ({
    ref,
    candidates: await inspectOimReleasePackages(dir),
  }));
}
