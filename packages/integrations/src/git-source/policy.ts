import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateNetworkAddress } from "../egress/destination";

/**
 * Clone-source cage. A scan source is pasted by an authenticated caller and handed to `git`
 * running inside the deployment's own network and filesystem, so an unguarded one is an SSRF and
 * local-read primitive: `file:///srv`, `http://10.0.0.5/`, `https://169.254.169.254/`. The gate is
 * an allowlist of hosts rather than a denylist of addresses, because every encoded form of a
 * private address — decimal, octal, hex, IPv4-mapped IPv6 — fails an exact host match without
 * having to be enumerated.
 */

export type GitSourceDenial =
  | "malformed_source"
  | "invalid_ref"
  | "unsupported_scheme"
  | "embedded_credentials"
  | "host_not_allowed"
  | "private_destination"
  | "unresolved_destination"
  | "too_many_clones"
  | "clone_timeout"
  | "repository_too_large"
  | "clone_failed";

/**
 * Operator-facing text for every denial. `clone_failed` deliberately says nothing about what git
 * reported: the raw stderr carries the assembled command line and the server temp path.
 */
const DENIAL_MESSAGES: Readonly<Record<GitSourceDenial, string>> = {
  malformed_source:
    'Source must be an "owner/repo" slug or an https URL, with an optional #branch suffix.',
  invalid_ref: "The #branch suffix may only contain letters, digits, dots, dashes and slashes.",
  unsupported_scheme: "Only https git sources can be cloned.",
  embedded_credentials: "The source URL must not carry a username or password.",
  host_not_allowed: "That host is not an approved git source.",
  private_destination: "That host is not publicly routable.",
  unresolved_destination: "That host could not be resolved.",
  too_many_clones: "Too many repository scans are already running. Try again in a moment.",
  clone_timeout: "The repository took too long to clone.",
  repository_too_large: "The repository is larger than the scan limit.",
  clone_failed: "Repository not found or not accessible.",
};

export class GitSourceError extends Error {
  readonly name = "GitSourceError";

  constructor(readonly denial: GitSourceDenial) {
    super(DENIAL_MESSAGES[denial]);
  }
}

/** HTTP shape for a denial; anything else is not this module's to answer. */
export function gitSourceHttpError(
  error: unknown
): { status: 400 | 429; body: { error: string } } | undefined {
  if (!(error instanceof GitSourceError)) return undefined;
  return { status: error.denial === "too_many_clones" ? 429 : 400, body: { error: error.message } };
}

const SLUG_RE = /^[\w.-]+\/[\w.-]+$/;
/** Leading dash forbidden so a ref can never be mistaken for a git flag. */
const REF_RE = /^[\w][\w./-]*$/;
const DEFAULT_ALLOWED_HOSTS = ["github.com"];

function allowedHosts(): ReadonlySet<string> {
  const configured = (process.env.GIT_SOURCE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");
  return new Set([...DEFAULT_ALLOWED_HOSTS, ...configured]);
}

/**
 * Local repositories are a local-read primitive, so they are off unless an operator turns them on
 * for an offline deployment that serves its catalog from disk.
 */
function localPathsAllowed(): boolean {
  return process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS === "1";
}

/** Pre-merge branches can be scanned: "owner/repo#my-branch". No "#" means the default branch. */
export function splitGitSourceRef(source: string): { base: string; ref?: string } {
  const index = source.indexOf("#");
  return index === -1
    ? { base: source }
    : { base: source.slice(0, index), ref: source.slice(index + 1) };
}

export type GitHostResolver = (hostname: string) => Promise<readonly string[]>;

async function resolveHost(hostname: string): Promise<readonly string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

function hostnameOf(url: URL): string {
  const literal = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  // A trailing dot is the same name to a resolver but a different string to an allowlist.
  return (literal.endsWith(".") ? literal.slice(0, -1) : literal).toLowerCase();
}

export interface ClonableGitSource {
  /** The exact URL to hand to git, rebuilt from the host that was actually checked. */
  readonly url: string;
  readonly ref?: string;
}

/**
 * Decide whether a caller-supplied source may be cloned, before any process is started.
 *
 * The resolved-address check narrows the DNS-rebinding window rather than closing it: the answers
 * are not pinned to the socket git then opens, so a record that changes between this call and the
 * connection is not caught. Closing it needs a connector git does not expose.
 *
 * @throws GitSourceError with the denial that stopped it.
 */
export async function assertClonableGitSource(
  source: string,
  options: { resolve?: GitHostResolver } = {}
): Promise<ClonableGitSource> {
  const { base, ref } = splitGitSourceRef(source);
  if (ref !== undefined && !REF_RE.test(ref)) throw new GitSourceError("invalid_ref");
  const normalized = SLUG_RE.test(base) ? `https://github.com/${base}.git` : base;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new GitSourceError("malformed_source");
  }

  if (url.protocol === "file:") {
    if (!localPathsAllowed()) throw new GitSourceError("unsupported_scheme");
    return { url: normalized, ref };
  }
  if (url.protocol !== "https:") throw new GitSourceError("unsupported_scheme");
  if (url.username !== "" || url.password !== "") {
    throw new GitSourceError("embedded_credentials");
  }

  const host = hostnameOf(url);
  if (host === "") throw new GitSourceError("malformed_source");
  if (isIP(host) !== 0) {
    if (isPrivateNetworkAddress(host)) throw new GitSourceError("private_destination");
    if (!allowedHosts().has(host)) throw new GitSourceError("host_not_allowed");
    return { url: url.toString(), ref };
  }
  if (!allowedHosts().has(host)) throw new GitSourceError("host_not_allowed");

  const addresses = await (options.resolve ?? resolveHost)(host).catch(() => []);
  if (addresses.length === 0) throw new GitSourceError("unresolved_destination");
  if (addresses.some(isPrivateNetworkAddress)) throw new GitSourceError("private_destination");

  url.hostname = host;
  return { url: url.toString(), ref };
}
