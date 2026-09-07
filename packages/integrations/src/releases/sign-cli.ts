import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOimManifest } from "@tulipfarm/schema";
import {
  createEd25519OimReleaseSigner,
  type OimRevocation,
  type OimRevocationList,
  signOimRelease,
  signOimRevocationList,
} from "./signatures";

export interface SigningCliIo {
  readFile(path: string): Promise<Uint8Array>;
  realpath(path: string): Promise<string>;
  writeFileExclusive(path: string, content: string): Promise<void>;
}

type SigningCommand = "release" | "revocations";

interface SigningOptions {
  readonly command: SigningCommand;
  readonly input: string;
  readonly privateKey: string;
  readonly keyId: string;
  readonly output: string;
}

function inside(root: string, path: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(path));
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function options(args: readonly string[]): SigningOptions {
  const [command, ...flags] = args;
  if (command !== "release" && command !== "revocations") {
    throw new Error("usage: sign-cli <release|revocations> [options]");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !["--manifest", "--input", "--private-key", "--key-id", "--output"].includes(flag)
    ) {
      throw new Error("invalid OIM signing CLI options");
    }
    if (values.has(flag)) throw new Error(`duplicate OIM signing option ${flag}`);
    values.set(flag, value);
  }
  const input = values.get(command === "release" ? "--manifest" : "--input");
  const privateKey = values.get("--private-key");
  const keyId = values.get("--key-id");
  const output = values.get("--output");
  if (
    input === undefined ||
    privateKey === undefined ||
    keyId === undefined ||
    output === undefined ||
    keyId.length === 0
  ) {
    throw new Error("missing required OIM signing CLI option");
  }
  if (!isAbsolute(privateKey)) {
    throw new Error("OIM signing private key must be an absolute path outside the repository");
  }
  if (
    (command === "release" && values.has("--input")) ||
    (command === "revocations" && values.has("--manifest"))
  ) {
    throw new Error("input option does not match OIM signing command");
  }
  return {
    command,
    input: resolve(input),
    privateKey: resolve(privateKey),
    keyId,
    output: resolve(output),
  };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseRevocationList(source: string): OimRevocationList {
  const parsed = record(JSON.parse(source));
  if (
    parsed === undefined ||
    !Number.isSafeInteger(parsed.sequence) ||
    typeof parsed.issuedAt !== "string" ||
    typeof parsed.expiresAt !== "string" ||
    !Array.isArray(parsed.revocations)
  ) {
    throw new Error("invalid OIM revocation list");
  }
  const issuedAt = Date.parse(parsed.issuedAt);
  const expiresAt = Date.parse(parsed.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    new Date(issuedAt).toISOString() !== parsed.issuedAt ||
    new Date(expiresAt).toISOString() !== parsed.expiresAt ||
    expiresAt <= issuedAt
  ) {
    throw new Error("invalid OIM revocation list time window");
  }
  const revocations: OimRevocation[] = parsed.revocations.map((value) => {
    const entry = record(value);
    if (
      entry === undefined ||
      typeof entry.integrationId !== "string" ||
      typeof entry.version !== "string" ||
      typeof entry.packageDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.packageDigest) ||
      typeof entry.reason !== "string" ||
      entry.reason.length === 0
    ) {
      throw new Error("invalid OIM revocation entry");
    }
    return {
      integrationId: entry.integrationId,
      version: entry.version,
      packageDigest: entry.packageDigest,
      reason: entry.reason,
    };
  });
  return {
    sequence: parsed.sequence as number,
    issuedAt: parsed.issuedAt,
    expiresAt: parsed.expiresAt,
    revocations,
  };
}

export async function runOimSigningCli(
  args: readonly string[],
  io: SigningCliIo,
  repositoryRoot: string
): Promise<void> {
  const parsed = options(args);
  const privateKeyPath = await io.realpath(parsed.privateKey);
  if (!isAbsolute(privateKeyPath) || inside(repositoryRoot, privateKeyPath)) {
    throw new Error("OIM signing private key must be an absolute path outside the repository");
  }
  const privateKeyPem = text(await io.readFile(privateKeyPath));
  const signer = createEd25519OimReleaseSigner(parsed.keyId, privateKeyPem);

  let envelope: unknown;
  if (parsed.command === "release") {
    const manifestSource = text(await io.readFile(parsed.input));
    const manifest = parseOimManifest(manifestSource);
    const packageDirectory = dirname(parsed.input);
    const files = new Map<string, Uint8Array>();
    for (const file of manifest.files ?? []) {
      const path = resolve(packageDirectory, file.path);
      if (!inside(packageDirectory, path)) {
        throw new Error(`OIM companion escapes package directory: ${file.path}`);
      }
      files.set(file.path, await io.readFile(path));
    }
    envelope = signOimRelease({ manifest, files }, signer);
  } else {
    envelope = signOimRevocationList(
      parseRevocationList(text(await io.readFile(parsed.input))),
      signer
    );
  }

  await io.writeFileExclusive(parsed.output, `${JSON.stringify(envelope, null, 2)}\n`);
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  const io: SigningCliIo = {
    readFile: (path) => readFile(path),
    realpath,
    writeFileExclusive: (path, content) =>
      writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o644 }),
  };
  const repositoryRoot = resolve(dirname(modulePath), "../../../..");
  runOimSigningCli(process.argv.slice(2), io, repositoryRoot).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "OIM signing failed"}\n`);
    process.exitCode = 1;
  });
}
