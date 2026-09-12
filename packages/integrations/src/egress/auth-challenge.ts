/**
 * Deterministic parsing of provider authentication challenges.
 *
 * An Agent may propose authentication from a person's instructions, from public documentation, or
 * from an error body — but the injection rule a person confirms has to come from something read
 * the same way every time, not from a model's summary of prose. Everything here is a pure function
 * over the response the provider actually sent.
 */

/** One parsed `WWW-Authenticate` challenge. */
export interface AuthChallenge {
  /** Lowercased authentication scheme, e.g. `bearer`. */
  readonly scheme: string;
  /** Lowercased `auth-param` names mapped to their unescaped values. */
  readonly params: Readonly<Record<string, string>>;
  /** The `token68` form, when the challenge used it instead of parameters. */
  readonly token68?: string;
}

/** Where a confirmed credential is placed on the outgoing request. */
export type AuthInjectionLocation = "header" | "query";

/**
 * The exact, confirmable rule for applying an ad-hoc credential.
 *
 * `origin` is always the origin of the request that was refused. A challenge may name a realm or a
 * URI, but honoring it would let a provider's error response point the caller's credential at a
 * host they never authorized, so those stay advisory.
 */
export interface AuthInjectionRule {
  readonly location: AuthInjectionLocation;
  /** Header or query parameter name, lowercased for headers. */
  readonly name: string;
  /** Literal text placed before the secret value, e.g. `"Bearer "`. */
  readonly valuePrefix: string;
  /** Origin this rule is bound to, taken from the request rather than the response. */
  readonly origin: string;
  /** The scheme this rule satisfies, or `api_key` for a documented key header. */
  readonly scheme: string;
  /** How the secret value must be shaped before the prefix is applied. */
  readonly encoding: "verbatim" | "basic_userinfo";
  /** Advisory realm the provider named. Never used for routing or storage keys. */
  readonly realm?: string;
}

/** Why a challenge cannot become a confirmable injection rule. */
export type UnsupportedAuthReason =
  | "multi_round_scheme"
  | "session_cookie"
  | "unknown_scheme"
  | "no_challenge";

export interface UnsupportedAuthChallenge {
  readonly scheme: string;
  readonly reason: UnsupportedAuthReason;
}

export interface AuthChallengeAnalysis {
  readonly supported: readonly AuthInjectionRule[];
  readonly unsupported: readonly UnsupportedAuthChallenge[];
}

const TOKEN = /[!#$%&'*+\-.^_`|~0-9A-Za-z]+/y;
const TOKEN68 = /[A-Za-z0-9\-._~+/]+=*/y;
const QUOTED = /"(?:[^"\\]|\\.)*"/y;
const OWS = /[ \t]*/y;

function match(re: RegExp, source: string, at: number): string | undefined {
  re.lastIndex = at;
  return re.exec(source)?.[0];
}

/**
 * Parse a `WWW-Authenticate` field value into its challenges.
 *
 * The grammar in RFC 9110 §11.6.1 overloads the comma as both a challenge separator and an
 * `auth-param` separator, so the only reliable signal that a token starts a new challenge is that
 * it is *not* followed by `=`. Anything that fails to parse is dropped rather than guessed at: a
 * half-understood challenge is exactly the input that should never reach a confirmation prompt.
 */
export function parseAuthChallenges(headerValue: string | undefined): readonly AuthChallenge[] {
  if (headerValue === undefined) return [];
  const source = headerValue;
  const challenges: AuthChallenge[] = [];
  let at = 0;
  const skipSeparators = (): void => {
    while (at < source.length) {
      const ws = match(OWS, source, at) ?? "";
      at += ws.length;
      if (source[at] === ",") at += 1;
      else break;
    }
  };

  skipSeparators();
  while (at < source.length) {
    const scheme = match(TOKEN, source, at);
    if (scheme === undefined) break;
    at += scheme.length;
    const params: Record<string, string> = {};
    let token68: string | undefined;

    for (;;) {
      const beforeItem = at;
      at += (match(OWS, source, at) ?? "").length;
      const name = match(TOKEN, source, at);
      if (name === undefined) {
        at = beforeItem;
        break;
      }
      let after = at + name.length;
      after += (match(OWS, source, after) ?? "").length;
      if (source[after] !== "=" || source[after + 1] === "=") {
        // Not `name=value`. Either the scheme's token68 argument, or the next challenge's scheme.
        const candidate =
          Object.keys(params).length === 0 && token68 === undefined
            ? match(TOKEN68, source, at)
            : undefined;
        if (candidate !== undefined && startsNewItem(source, at + candidate.length)) {
          token68 = candidate;
          at += candidate.length;
          continue;
        }
        at = beforeItem;
        break;
      }
      after += 1;
      after += (match(OWS, source, after) ?? "").length;
      const quoted = match(QUOTED, source, after);
      if (quoted !== undefined) {
        params[name.toLowerCase()] = unescapeQuoted(quoted);
        at = after + quoted.length;
      } else {
        const bare = match(TOKEN, source, after);
        if (bare === undefined) {
          at = beforeItem;
          break;
        }
        params[name.toLowerCase()] = bare;
        at = after + bare.length;
      }
      const beforeComma = at;
      at += (match(OWS, source, at) ?? "").length;
      if (source[at] === ",") skipSeparators();
      else {
        at = beforeComma;
        break;
      }
    }

    challenges.push({
      scheme: scheme.toLowerCase(),
      params,
      ...(token68 === undefined ? {} : { token68 }),
    });
    skipSeparators();
  }
  return challenges;
}

/** Whether the position ends the current item, so a token68 read cannot have swallowed a scheme. */
function startsNewItem(source: string, at: number): boolean {
  const rest = source.slice(at).replace(/^[ \t]*/, "");
  return rest.length === 0 || rest.startsWith(",");
}

function unescapeQuoted(value: string): string {
  return value.slice(1, -1).replace(/\\(.)/g, "$1");
}

const MULTI_ROUND_SCHEMES: ReadonlySet<string> = new Set(["negotiate", "ntlm", "digest"]);

/**
 * Turn parsed challenges into rules a person can confirm, bound to `requestOrigin`.
 *
 * Schemes that need more than one round trip are refused rather than approximated: a rule that
 * cannot be satisfied by attaching one stored value to one request is not a rule this Tool can
 * honestly ask someone to approve.
 */
export function analyzeAuthChallenges(
  challenges: readonly AuthChallenge[],
  requestOrigin: string
): AuthChallengeAnalysis {
  const supported: AuthInjectionRule[] = [];
  const unsupported: UnsupportedAuthChallenge[] = [];
  for (const challenge of challenges) {
    const realm = challenge.params.realm;
    const shared = {
      location: "header" as const,
      name: "authorization",
      origin: requestOrigin,
      scheme: challenge.scheme,
      ...(realm === undefined ? {} : { realm }),
    };
    if (challenge.scheme === "bearer") {
      supported.push({ ...shared, valuePrefix: "Bearer ", encoding: "verbatim" });
    } else if (challenge.scheme === "basic") {
      supported.push({ ...shared, valuePrefix: "Basic ", encoding: "basic_userinfo" });
    } else if (MULTI_ROUND_SCHEMES.has(challenge.scheme)) {
      unsupported.push({ scheme: challenge.scheme, reason: "multi_round_scheme" });
    } else if (challenge.scheme === "cookie") {
      unsupported.push({ scheme: challenge.scheme, reason: "session_cookie" });
    } else {
      unsupported.push({ scheme: challenge.scheme, reason: "unknown_scheme" });
    }
  }
  return { supported, unsupported };
}

/** Header names that carry a browser session rather than a credential a person may delegate. */
const SESSION_HEADERS: ReadonlySet<string> = new Set(["cookie", "set-cookie"]);

/**
 * Whether a proposed header name is a copied browser session rather than an issued credential.
 *
 * Pasting a `Cookie` header works, which is exactly why it has to be refused: it hands an Agent a
 * whole authenticated browser session, unscoped and unrevocable, in place of a token whose reach
 * the person could reason about.
 */
export function isSessionHeader(name: string): boolean {
  return SESSION_HEADERS.has(name.trim().toLowerCase());
}

/** Statuses that may carry an authentication challenge worth surfacing. */
export function isAuthenticationFailure(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Analyze a refused response. Returns `undefined` when the response was not an authentication
 * failure, so callers can keep their ordinary error path.
 */
export function detectAuthChallenge(
  status: number,
  headers: Readonly<Record<string, string>>,
  requestOrigin: string
): AuthChallengeAnalysis | undefined {
  if (!isAuthenticationFailure(status)) return undefined;
  const header = headers["www-authenticate"] ?? headers["WWW-Authenticate"];
  const challenges = parseAuthChallenges(header);
  if (challenges.length === 0) {
    return { supported: [], unsupported: [{ scheme: "", reason: "no_challenge" }] };
  }
  return analyzeAuthChallenges(challenges, requestOrigin);
}
