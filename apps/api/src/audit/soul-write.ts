/** Audit helper for direct Soul writes, which bypass Run-mediated audit emission. */

import type { FastifyRequest } from "fastify";
import type { UserDoc } from "../auth/users";
import type { AuditService } from "./service";

/** Marks an event as a direct Soul repository write rather than a Run-mediated change. */
export const SOUL_DIRECT_WRITE = "SOUL_DIRECT_WRITE";

/** Records after commit; audit failure must not turn success into retryable failure. */
export function makeSoulAuditWriter(audit?: AuditService) {
  return (
    req: FastifyRequest,
    action: string,
    target: string,
    meta?: Record<string, unknown>
  ): Promise<void> =>
    audit?.recordOrWarn({
      actorId: (req.user as UserDoc | undefined)?._id ?? null,
      action,
      target,
      reasonCodes: [SOUL_DIRECT_WRITE],
      ...(meta ? { safeMetadata: meta } : {}),
    }) ?? Promise.resolve();
}

/** What {@link makeSoulAuditWriter} returns — for call sites that store it on a deps object. */
export type SoulAuditWriter = ReturnType<typeof makeSoulAuditWriter>;

/** Returns only credential-free git locators safe for the append-only audit ledger. */
export function redactRemoteUrl(remoteUrl: string): string {
  const candidate = remoteUrl.trim();
  // WHATWG URL parsing can hide control characters; reject before redaction.
  if (hasControlOrSpace(candidate)) return "unparsed";
  if (candidate.length > MAX_REMOTE_LENGTH) return "unparsed";
  // scp-style has no `://`, and its user-less form (`host:path`) otherwise parses as scheme
  // `host:` and would be discarded as an unknown scheme. Shorthand is the fallback because
  // `acme/skills` is neither a URL nor scp-style, yet is the commonest source of all.
  if (!candidate.includes("://")) {
    const scp = scpStyle(candidate);
    return scp === "unparsed" ? shorthand(candidate) : scp;
  }

  try {
    const url = new URL(candidate);
    // Only real remote-transport schemes. `file:`, `data:` and friends are not git remotes, and
    // echoing their contents back into the ledger discloses local paths for no benefit.
    if (!GIT_URL_SCHEMES.has(url.protocol)) return "unparsed";
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    const scp = scpStyle(candidate);
    return scp === "unparsed" ? shorthand(candidate) : scp;
  }
}

/** Allows credential-free shorthand sources that cannot carry URL userinfo. */
function shorthand(candidate: string): string {
  const [locator, ...rest] = candidate.split("#");
  if (rest.length > 1) return "unparsed";
  if (locator === undefined || locator === "") return "unparsed";
  const segments = locator.split("/");
  if (segments.length > MAX_SHORTHAND_SEGMENTS) return "unparsed";
  for (const segment of segments) {
    // Rejects empty, `.` and `..` — traversal shapes are not repo locators, and passing arbitrary
    // path junk through would make this branch a hole rather than a narrow allowance.
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment)) return "unparsed";
    if (segment === "." || segment === "..") return "unparsed";
  }
  const ref = rest[0];
  if (ref !== undefined && !/^[A-Za-z0-9._/-]+$/.test(ref)) return "unparsed";
  return candidate;
}

/** `host.tld/org/repo` is the longest legitimate shorthand; more segments is not a locator. */
const MAX_SHORTHAND_SEGMENTS = 4;

/** Beyond this a "remote" is a blob, not a locator, and is not worth keeping forever. */
const MAX_REMOTE_LENGTH = 512;

/** Removes only userinfo; provenance fields preserve non-URL/file sources byte-for-byte. */
export function stripUrlCredentials(source: string): string {
  return source.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/]*@/, "$1");
}

/** scp-style remotes are tried before `URL`; user-less forms otherwise parse as schemes. */
function scpStyle(candidate: string): string {
  const scp = /^(?:[^@\s/:]+@)?([A-Za-z0-9._-]+):([^\s]+)$/.exec(candidate);
  if (!scp) return "unparsed";
  const [, host, path] = scp;
  // A real remote host is an FQDN, an IP, or `localhost`. Without this, non-transport schemes
  // reach here and pass straight through — `data:text/plain,<secret>` matches the shape exactly.
  if (host === undefined || path === undefined) return "unparsed";
  if (host !== "localhost" && !host.includes(".")) return "unparsed";
  return `${host}:${path}`;
}

/** Avoids a regex made from control characters, which Biome rejects. */
function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Schemes git actually clones over. Anything else is not a remote and is not recorded. */
const GIT_URL_SCHEMES = new Set(["https:", "http:", "ssh:", "git:", "git+ssh:"]);
