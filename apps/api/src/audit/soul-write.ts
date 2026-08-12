/**
 * Audit emission for routes that mutate the Soul repository directly.
 *
 * These routes bypass the Run path entirely — they write files and commit git themselves — so
 * nothing upstream records who reshaped the business's configuration. Without this, the audit
 * ledger answers "what did an Agent do" but not "who changed what the Agents *are*", which is the
 * more consequential question.
 *
 * The helper is shared rather than copied per route file for a specific reason: `reasonCodes` and
 * the actor-extraction shape are what make these events queryable as a class. Four independent
 * copies drift, and a drifted `reasonCode` is invisible until someone runs the query that needed
 * it.
 */

import type { FastifyRequest } from "fastify";
import type { UserDoc } from "../auth/users";
import type { AuditService } from "./service";

/** Marks an event as a direct Soul repository write rather than a Run-mediated change. */
export const SOUL_DIRECT_WRITE = "SOUL_DIRECT_WRITE";

/**
 * Records a Soul mutation, attributed to the signed-in user.
 *
 * `recordOrWarn`, not `record`: every call site invokes this *after* the file write and git commit
 * have already landed. Throwing would report an error for work that actually succeeded — and the
 * event is lost either way, so the failed request buys nothing but a confused operator and a
 * client that retries a write it already made.
 */
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

/**
 * A remote URL with any embedded credential removed, safe to keep forever.
 *
 * Operators paste `https://user:token@host/repo` into both the git-remote and skill-install
 * flows, and the audit package's protected-value patterns only catch *recognised* token formats
 * (`ghp_`, `xoxb-`, `sk-`). A generic password in the userinfo position would sail through and be
 * written into an append-only ledger that is deliberately hard to erase.
 *
 * Returns `"unparsed"` rather than the original string whenever the input is not a plain remote
 * URL, an scp-style locator, or credential-free shorthand. That is deliberately strict: an input
 * this function cannot fully account for is exactly the one most likely to be hiding a credential,
 * and the ledger cannot be edited afterwards.
 */
export function redactRemoteUrl(remoteUrl: string): string {
  const candidate = remoteUrl.trim();
  // The WHATWG URL parser *silently deletes* tab, newline and CR and folds whatever followed into
  // the path — so `https://h/r\nAUTH: tok` parses to path `/rAUTH:%20tok` and the secret survives
  // redaction. Reject these outright rather than trying to preserve a mangled URL.
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

/**
 * Credential-free shorthand: `acme/skills`, `acme/skills#main`, `builtin`, `github.com/acme/x`.
 *
 * Skill and Integration sources are usually written this way, not as full URLs — so without this
 * branch the commonest inputs of all collapse to `"unparsed"` and the audit event loses the one
 * fact it exists to record. A credential can only ride in via userinfo, which requires `@` (or a
 * `:` before a host, already handled by `scpStyle`), so a string with neither cannot carry one.
 */
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

/**
 * The same string with only an embedded credential removed — everything else byte-identical.
 *
 * This is the counterpart to `redactRemoteUrl`, for fields that are *functional provenance* rather
 * than ledger evidence: `skills-lock.json` is committed to the Soul repo and served back out of
 * the API, so it must faithfully record `file://` and shorthand sources that `redactRemoteUrl`
 * deliberately refuses. The strict policy is right for an append-only ledger and wrong here.
 *
 * Deliberately not `new URL`: that parser silently deletes control characters and rewrites the
 * path, so round-tripping through it can both mangle a legitimate source and, with a crafted
 * input, carry a secret past redaction. Matching greedily up to the last `@` before the first `/`
 * is what defeats `https://a@b:token@host/r`, where a non-greedy match leaves the token behind.
 */
export function stripUrlCredentials(source: string): string {
  return source.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/]*@/, "$1");
}

/**
 * scp-style (`git@host:org/repo`, or `host:org/repo` with the user implied).
 *
 * Tried before `new URL` for scheme-less input because the user-less form parses "successfully"
 * as scheme `host:` — which would be rejected as an unknown scheme and lose real provenance.
 * The user part is dropped so this cannot disagree with the URL branch about what identifies a
 * remote; scp syntax has no password field, so nothing else here is secret.
 */
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

/**
 * True for any character at or below `0x20`, plus DEL.
 *
 * Written as a scan rather than a regex because the equivalent character class is itself made of
 * control characters, which is exactly the construct `noControlCharactersInRegex` exists to catch.
 */
function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Schemes git actually clones over. Anything else is not a remote and is not recorded. */
const GIT_URL_SCHEMES = new Set(["https:", "http:", "ssh:", "git:", "git+ssh:"]);
