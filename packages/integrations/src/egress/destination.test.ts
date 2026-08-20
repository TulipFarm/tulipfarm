import { describe, expect, it, vi } from "vitest";
import type { IntegrationHttpResponse } from "../http";
import {
  assertPublicAddresses,
  assertPublicEgressUrl,
  EgressDestinationError,
  GuardedEgressHttp,
  isPrivateNetworkAddress,
} from "./destination";

function denial(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof EgressDestinationError ? error.denial : `unexpected:${error}`;
  }
  return "allowed";
}

describe("isPrivateNetworkAddress", () => {
  it("denies every reserved IPv4 range a manifest could aim inward", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateNetworkAddress(address), address).toBe(true);
    }
  });

  it("allows ordinary public IPv4", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "140.82.121.4", "172.32.0.1", "100.63.255.255"]) {
      expect(isPrivateNetworkAddress(address), address).toBe(false);
    }
  });

  it("denies loopback, unique-local, link-local and IPv4-mapped IPv6", () => {
    for (const address of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateNetworkAddress(address), address).toBe(true);
    }
    expect(isPrivateNetworkAddress("2606:4700::1111")).toBe(false);
    expect(isPrivateNetworkAddress("::ffff:8.8.8.8")).toBe(false);
  });

  // `new URL()` rewrites the dotted mapped form to hextets, so both spellings reach a guard.
  it("denies an IPv4-mapped address written as hextets", () => {
    for (const address of ["::ffff:7f00:1", "::ffff:a00:5", "::ffff:c0a8:1", "::ffff:a9fe:a9fe"]) {
      expect(isPrivateNetworkAddress(address), address).toBe(true);
    }
    expect(isPrivateNetworkAddress("::ffff:808:808")).toBe(false);
  });

  it("denies anything that is not an address, because a guard that cannot tell must not allow", () => {
    for (const value of ["", "not-an-ip", "10.1.2", "10.1.2.3.4", "999.1.1.1"]) {
      expect(isPrivateNetworkAddress(value), value).toBe(true);
    }
  });
});

describe("assertPublicEgressUrl", () => {
  it("accepts an ordinary public HTTPS destination", () => {
    expect(denial(() => assertPublicEgressUrl(new URL("https://api.example.com/v1"), "x"))).toBe(
      "allowed"
    );
  });

  it("refuses a literal private address, the cloud-metadata case", () => {
    expect(denial(() => assertPublicEgressUrl(new URL("https://169.254.169.254/"), "x"))).toBe(
      "private_destination"
    );
    expect(denial(() => assertPublicEgressUrl(new URL("https://10.0.0.5/admin"), "x"))).toBe(
      "private_destination"
    );
    expect(denial(() => assertPublicEgressUrl(new URL("https://[::1]/"), "x"))).toBe(
      "private_destination"
    );
  });

  it("refuses plaintext and embedded credentials", () => {
    expect(denial(() => assertPublicEgressUrl(new URL("http://api.example.com/"), "x"))).toBe(
      "not_https"
    );
    expect(denial(() => assertPublicEgressUrl(new URL("https://u:p@api.example.com/"), "x"))).toBe(
      "embedded_credentials"
    );
  });

  it("lets a hostname through, because resolution belongs at request time", () => {
    // Compiling must not depend on a DNS answer that can differ by the time the Tool runs.
    expect(
      denial(() => assertPublicEgressUrl(new URL("https://metadata.google.internal/"), "x"))
    ).toBe("allowed");
  });
});

describe("assertPublicAddresses", () => {
  it("returns the answers when every one is public", () => {
    expect(assertPublicAddresses(["8.8.8.8", "1.1.1.1"], "host")).toEqual(["8.8.8.8", "1.1.1.1"]);
  });

  it("denies when any single answer is private, not merely when all are", () => {
    // A round-robin holding one inward address must not be dialled on the chance of the good one.
    expect(denial(() => assertPublicAddresses(["8.8.8.8", "169.254.169.254"], "host"))).toBe(
      "private_destination"
    );
  });

  it("denies a name that resolves to nothing", () => {
    expect(denial(() => assertPublicAddresses([], "host"))).toBe("unresolved_destination");
  });
});

describe("GuardedEgressHttp", () => {
  const REQUEST = {
    url: "https://api.example.com/v1/issues",
    method: "GET",
    headers: {},
  } as const;

  const OK: IntegrationHttpResponse = { status: 200, headers: {}, body: { id: 1 } };

  function inner() {
    return { send: vi.fn(async (): Promise<IntegrationHttpResponse> => OK) };
  }

  it("passes the request through when every resolved address is public", async () => {
    const transport = inner();
    const http = new GuardedEgressHttp(transport, { resolve: async () => ["140.82.121.4"] });

    expect(await http.send(REQUEST)).toEqual(OK);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("refuses a hostname that resolves inward, and never opens the socket", async () => {
    // The install-time literal check cannot see this: the manifest declared a public-looking name.
    const transport = inner();
    const http = new GuardedEgressHttp(transport, { resolve: async () => ["169.254.169.254"] });

    expect(await http.send(REQUEST)).toMatchObject({
      status: 403,
      body: { error: "private_destination" },
    });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("denies a private literal without asking a resolver that could vouch for it", async () => {
    const transport = inner();
    const resolve = vi.fn(async () => ["8.8.8.8"]);
    const http = new GuardedEgressHttp(transport, { resolve });

    expect(
      await http.send({ ...REQUEST, url: "https://169.254.169.254/latest/meta-data/" })
    ).toMatchObject({ status: 403, body: { error: "private_destination" } });
    expect(resolve).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("treats a name that resolves to nothing as a denial, not an outage", async () => {
    const transport = inner();
    const http = new GuardedEgressHttp(transport, { resolve: async () => [] });

    expect(await http.send(REQUEST)).toMatchObject({
      status: 403,
      body: { error: "unresolved_destination" },
    });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("denies when the resolver itself fails, rather than sending unchecked", async () => {
    const transport = inner();
    const http = new GuardedEgressHttp(transport, {
      resolve: async () => {
        throw new Error("EAI_AGAIN");
      },
    });

    expect(await http.send(REQUEST)).toMatchObject({ status: 403 });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("resolves a host once per window instead of on every call", async () => {
    const resolve = vi.fn(async () => ["140.82.121.4"]);
    const http = new GuardedEgressHttp(inner(), { resolve });

    await http.send(REQUEST);
    await http.send(REQUEST);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("re-checks once the window lapses, so a changed record cannot ride a stale pass", async () => {
    const resolve = vi.fn(async () => ["140.82.121.4"]);
    const http = new GuardedEgressHttp(inner(), { resolve, ttlMs: 0 });

    await http.send(REQUEST);
    await http.send(REQUEST);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
