import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { IntegrationHttpResponse } from "../http";
import type { EgressHttpPort, EgressHttpRequest } from "./openapi-adapter";

/**
 * Destination cage for manifest egress. A manifest is authored by an Agent from chat, so its
 * `base_url` is untrusted input that the deployment's own credential is then spent against: an
 * unguarded one reaches cloud metadata (`169.254.169.254`), a loopback admin port, or anything
 * else inside the perimeter. Enforced twice, because neither check subsumes the other — the
 * literal check fails an install outright, the resolved check catches a public name that points
 * inward.
 */

export type EgressDestinationDenial =
  | "not_https"
  | "embedded_credentials"
  | "no_host"
  | "private_destination"
  | "unresolved_destination";

/** Every denial `GuardedEgressHttp` can answer with, so a caller can tell its 403 from a server's. */
export const EGRESS_DENIAL_REASONS: ReadonlySet<string> = new Set<EgressDestinationDenial>([
  "not_https",
  "embedded_credentials",
  "no_host",
  "private_destination",
  "unresolved_destination",
]);

/**
 * The mark `GuardedEgressHttp` puts on its own refusals.
 *
 * A Symbol rather than a field, because the alternative is asking a body whether it is a policy
 * refusal — and the body is the destination's to write. A public server answering `403` with
 * `{"error":"private_destination"}` would otherwise be reported to the Agent, and to the person,
 * as this deployment's own refusal, complete with the claim that the site was never contacted. A
 * Symbol cannot be forged by anything that arrived as JSON off a socket.
 */
const EGRESS_DENIAL = Symbol.for("tulipfarm.egress.denial");

/**
 * Whether this response is the destination cage refusing, rather than the destination answering.
 *
 * Both are `403`, and an Agent told only "forbidden" will retry a request that this deployment
 * will never allow, or report a policy refusal to a person as the provider's decision.
 */
export function egressDenialReason(
  status: number,
  body: unknown
): EgressDestinationDenial | undefined {
  if (status !== 403 || typeof body !== "object" || body === null) return undefined;
  const marked = (body as Record<symbol, unknown>)[EGRESS_DENIAL];
  return typeof marked === "string" && EGRESS_DENIAL_REASONS.has(marked)
    ? (marked as EgressDestinationDenial)
    : undefined;
}

export class EgressDestinationError extends Error {
  readonly name = "EgressDestinationError";

  constructor(
    readonly denial: EgressDestinationDenial,
    readonly destination: string
  ) {
    super(`egress_destination:${denial}:${destination}`);
  }
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  // An address that does not parse is treated as private: the caller is deciding whether to send
  // a credential, and "cannot tell" must land on the deny side of that question.
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 88) ||
    (first === 192 && second === 0 && octets[2] === 2) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && octets[2] === 100) ||
    (first === 203 && second === 0 && octets[2] === 113) ||
    first >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  // `fec0::/10`, site-local. Deprecated by RFC 3879 and so not reachable on the public internet,
  // but still routed inside plenty of networks — which is exactly what an SSRF wants.
  if (/^fe[c-f]/.test(normalized)) return true;
  if (normalized.startsWith("ff") || normalized.startsWith("2001:db8:")) return true;
  if (normalized === "100::" || normalized.startsWith("100:0:0:0:")) return true;
  // Transition and translation ranges each carry an IPv4 address inside an IPv6 literal, so a
  // private v4 destination can be spelled as a v6 one that no v4 rule ever inspects. All are
  // deprecated or infrastructure-only, so refusing the whole range costs no real destination:
  // 6to4 (RFC 7526), Teredo, NAT64 (RFC 6052), benchmarking, and documentation.
  if (/^(2002:|2001:0{0,4}:|64:ff9b:|2001:2:0:|3fff:|5f00:)/.test(normalized)) return true;
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4 !== undefined) return isPrivateIpv4(mappedIpv4);
  // `new URL()` rewrites `::ffff:127.0.0.1` to `::ffff:7f00:1`, so the dotted form is not the
  // only spelling that reaches here.
  const hextets = normalized.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/);
  if (hextets !== null) {
    const [high, low] = [Number.parseInt(hextets[1], 16), Number.parseInt(hextets[2], 16)];
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  // IPv4-compatible `::a.b.c.d` (RFC 4291, deprecated). `::7f00:1` is 127.0.0.1 wearing a v6
  // spelling, and unlike `::ffff:` it carries no marker to catch it on.
  return /^::(\d+\.\d+\.\d+\.\d+|[\da-f]{1,4}:[\da-f]{1,4})$/.test(normalized);
}

/** Loopback, link-local, RFC 1918, CGNAT, multicast and IPv4-mapped IPv6 all count as private. */
export function isPrivateNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  // Not an address at all — the same "cannot tell" deny as an unparsable v4.
  return true;
}

/**
 * Install-time check on a manifest's declared `base_url`. Rejects a URL that is not HTTPS, carries
 * embedded credentials, or names a private address literally. A hostname passes here and is caught
 * at request time instead, because resolving during compilation would make an install depend on
 * DNS that can differ by the time the Tool runs.
 *
 * @throws EgressDestinationError when the URL may not be an egress destination.
 */
export function assertPublicEgressUrl(url: URL, destination: string): void {
  if (url.protocol !== "https:") throw new EgressDestinationError("not_https", destination);
  if (url.username !== "" || url.password !== "") {
    throw new EgressDestinationError("embedded_credentials", destination);
  }
  if (url.hostname === "") throw new EgressDestinationError("no_host", destination);
  const literal = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(literal) !== 0 && isPrivateNetworkAddress(literal)) {
    throw new EgressDestinationError("private_destination", destination);
  }
}

/**
 * Request-time check on what a hostname actually resolves to. Denies unless every answer is
 * public, so a single private address in a round-robin cannot be the one dialled.
 *
 * @throws EgressDestinationError when nothing resolves or any answer is private.
 */
export function assertPublicAddresses(
  addresses: readonly string[],
  destination: string
): readonly string[] {
  if (addresses.length === 0) {
    throw new EgressDestinationError("unresolved_destination", destination);
  }
  if (addresses.some(isPrivateNetworkAddress)) {
    throw new EgressDestinationError("private_destination", destination);
  }
  return addresses;
}

/** Answers stay usable far longer than one Run, and re-resolving every call is a per-call stall. */
const RESOLUTION_TTL_MS = 30_000;

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

async function resolveHost(hostname: string): Promise<readonly string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

export interface GuardedEgressHttpOptions {
  /** Injected so tests never touch DNS. */
  readonly resolve?: HostResolver;
  readonly ttlMs?: number;
}

/**
 * Wraps any egress transport so nothing leaves for a private address. Kept separate from the
 * transport because it is policy, not plumbing: the install-time check on `base_url` cannot see a
 * public-looking hostname whose record points inward, and only a resolution can.
 *
 * Denials surface as `403`, not as a transport failure — refusing to cross the perimeter is a
 * decision the effect ledger should record as denied rather than retry as an outage.
 */
export class GuardedEgressHttp implements EgressHttpPort {
  private readonly resolve: HostResolver;
  private readonly ttlMs: number;
  private readonly checked = new Map<
    string,
    { readonly checkedAt: number; readonly addresses: readonly string[] }
  >();

  constructor(
    private readonly inner: EgressHttpPort,
    options: GuardedEgressHttpOptions = {}
  ) {
    this.resolve = options.resolve ?? resolveHost;
    this.ttlMs = options.ttlMs ?? RESOLUTION_TTL_MS;
  }

  async send(request: EgressHttpRequest): Promise<IntegrationHttpResponse> {
    try {
      const addresses = await this.publicAddressesFor(request.url);
      return this.inner.send({ ...request, pinnedAddresses: addresses });
    } catch (error) {
      if (!(error instanceof EgressDestinationError)) throw error;
      // `error` stays for anything reading the body as data; the Symbol is what `egressDenialReason`
      // trusts, because only this line can set it.
      return {
        status: 403,
        headers: {},
        body: { error: error.denial, [EGRESS_DENIAL]: error.denial },
      };
    }
  }

  private async publicAddressesFor(rawUrl: string): Promise<readonly string[]> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new EgressDestinationError("no_host", rawUrl);
    }
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const cached = this.checked.get(hostname);
    if (cached !== undefined && Date.now() - cached.checkedAt < this.ttlMs) {
      return cached.addresses;
    }

    // A literal address needs no lookup, and asking a resolver about one invites an answer that
    // vouches for it. Check the literal itself.
    const addresses =
      isIP(hostname) === 0 ? await this.resolve(hostname).catch(() => []) : [hostname];
    const publicAddresses = assertPublicAddresses(addresses, hostname);
    this.checked.set(hostname, { checkedAt: Date.now(), addresses: publicAddresses });
    return publicAddresses;
  }
}
