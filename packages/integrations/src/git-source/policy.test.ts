import { afterEach, describe, expect, it } from "vitest";
import { assertClonableGitSource, GitSourceError, gitSourceHttpError } from "./policy";

/** Every resolver answer is public, so a denial can only come from the URL itself. */
const publicResolver = async () => ["93.184.216.34"];

afterEach(() => {
  delete process.env.GIT_SOURCE_ALLOWED_HOSTS;
  delete process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS;
});

async function denialFor(source: string): Promise<string> {
  try {
    await assertClonableGitSource(source, { resolve: publicResolver });
  } catch (error) {
    if (error instanceof GitSourceError) return error.denial;
    throw error;
  }
  return "allowed";
}

describe("assertClonableGitSource", () => {
  const forbidden: ReadonlyArray<readonly [string, string, string]> = [
    ["a local filesystem repository", "file:///srv/secrets/repo", "unsupported_scheme"],
    ["a bare local path", "/srv/secrets/repo", "malformed_source"],
    ["plain HTTP", "http://github.com/owner/repo.git", "unsupported_scheme"],
    ["an ssh URL", "ssh://internal-host/repo.git", "unsupported_scheme"],
    ["a git protocol URL", "git://internal-host/repo.git", "unsupported_scheme"],
    ["an scp-style source", "git@internal.example.com:secrets/repo.git", "malformed_source"],
    ["embedded credentials", "https://user:pass@github.com/o/r.git", "embedded_credentials"],
    ["a bare username", "https://token@github.com/o/r.git", "embedded_credentials"],
    ["IPv4 loopback", "https://127.0.0.1/o/r.git", "private_destination"],
    ["IPv4 loopback in another octet", "https://127.9.9.9/o/r.git", "private_destination"],
    ["IPv6 loopback", "https://[::1]/o/r.git", "private_destination"],
    ["the unspecified IPv4 address", "https://0.0.0.0/o/r.git", "private_destination"],
    ["the unspecified IPv6 address", "https://[::]/o/r.git", "private_destination"],
    ["the cloud metadata address", "https://169.254.169.254/o/r.git", "private_destination"],
    ["RFC 1918 10/8", "https://10.1.2.3/o/r.git", "private_destination"],
    ["RFC 1918 172.16/12 low", "https://172.16.0.1/o/r.git", "private_destination"],
    ["RFC 1918 172.16/12 high", "https://172.31.255.254/o/r.git", "private_destination"],
    ["RFC 1918 192.168/16", "https://192.168.1.1/o/r.git", "private_destination"],
    ["CGNAT 100.64/10", "https://100.100.0.1/o/r.git", "private_destination"],
    ["unique local IPv6 fc00::/7", "https://[fc00::1]/o/r.git", "private_destination"],
    ["unique local IPv6 fd00::/8", "https://[fd12:3456::1]/o/r.git", "private_destination"],
    ["link-local IPv6 fe80::/10", "https://[fe80::1]/o/r.git", "private_destination"],
    ["IPv4-mapped IPv6", "https://[::ffff:127.0.0.1]/o/r.git", "private_destination"],
    ["a public IP literal off the allowlist", "https://93.184.216.34/o/r.git", "host_not_allowed"],
    ["decimal-encoded IPv4", "https://2130706433/o/r.git", "private_destination"],
    ["hex-encoded IPv4", "https://0x7f000001/o/r.git", "private_destination"],
    ["octal-encoded IPv4", "https://0177.0.0.1/o/r.git", "private_destination"],
    ["an unapproved host", "https://git.internal.example/o/r.git", "host_not_allowed"],
    ["a trailing-dot unapproved host", "https://git.internal.example./o/r.git", "host_not_allowed"],
    [
      "an allowlisted host as a subdomain suffix",
      "https://github.com.evil.tld/o/r.git",
      "host_not_allowed",
    ],
    ["a ref that looks like a git flag", "owner/repo#--upload-pack=evil", "invalid_ref"],
    ["a ref with a shell metacharacter", "owner/repo#main;rm -rf /", "invalid_ref"],
    ["a source that is not a URL at all", "not a url", "malformed_source"],
  ];

  it.each(forbidden)("rejects %s", async (_label, source, denial) => {
    expect(await denialFor(source)).toBe(denial);
  });

  const allowed: ReadonlyArray<readonly [string, string, string]> = [
    ["an owner/repo slug", "TulipFarm/skills", "https://github.com/TulipFarm/skills.git"],
    ["a slug with a branch", "TulipFarm/skills#next", "https://github.com/TulipFarm/skills.git"],
    ["an https GitHub URL", "https://github.com/o/r.git", "https://github.com/o/r.git"],
    ["a mixed-case host", "https://GitHub.com/o/r.git", "https://github.com/o/r.git"],
    [
      "a trailing-dot allowlisted host",
      "https://github.com./o/r.git",
      "https://github.com/o/r.git",
    ],
  ];

  it.each(allowed)("allows %s", async (_label, source, url) => {
    const target = await assertClonableGitSource(source, { resolve: publicResolver });
    expect(target.url).toBe(url);
  });

  it("carries the branch through", async () => {
    const target = await assertClonableGitSource("TulipFarm/skills#next", {
      resolve: publicResolver,
    });
    expect(target.ref).toBe("next");
  });

  // DNS rebinding: the name passes the allowlist, the answer does not.
  it("rejects an allowlisted host whose DNS answer is private", async () => {
    process.env.GIT_SOURCE_ALLOWED_HOSTS = "git.example.com";
    const target = assertClonableGitSource("https://git.example.com/o/r.git", {
      resolve: async () => ["93.184.216.34", "10.0.0.5"],
    });
    await expect(target).rejects.toMatchObject({ denial: "private_destination" });
  });

  it("rejects an allowlisted host that resolves to nothing", async () => {
    process.env.GIT_SOURCE_ALLOWED_HOSTS = "git.example.com";
    const target = assertClonableGitSource("https://git.example.com/o/r.git", {
      resolve: async () => [],
    });
    await expect(target).rejects.toMatchObject({ denial: "unresolved_destination" });
  });

  it("allows a host an operator explicitly approved", async () => {
    process.env.GIT_SOURCE_ALLOWED_HOSTS = " git.example.com , gitlab.com ";
    const target = await assertClonableGitSource("https://gitlab.com/o/r.git", {
      resolve: publicResolver,
    });
    expect(target.url).toBe("https://gitlab.com/o/r.git");
  });

  it("allows a local repository only when the operator opted in", async () => {
    expect(await denialFor("file:///srv/repo")).toBe("unsupported_scheme");
    process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS = "1";
    expect(await denialFor("file:///srv/repo")).toBe("allowed");
  });

  // The opt-in is for local paths only; it must not reopen the network.
  it("keeps the network policy in force when local paths are allowed", async () => {
    process.env.GIT_SOURCE_ALLOW_LOCAL_PATHS = "1";
    expect(await denialFor("https://127.0.0.1/o/r.git")).toBe("private_destination");
    expect(await denialFor("http://github.com/o/r.git")).toBe("unsupported_scheme");
  });
});

describe("gitSourceHttpError", () => {
  it("answers 429 for a concurrency refusal and 400 for a policy refusal", () => {
    expect(gitSourceHttpError(new GitSourceError("too_many_clones"))?.status).toBe(429);
    expect(gitSourceHttpError(new GitSourceError("host_not_allowed"))?.status).toBe(400);
  });

  it("reports a clone failure without quoting git", () => {
    const mapped = gitSourceHttpError(new GitSourceError("clone_failed"));
    expect(mapped?.body).toEqual({ error: "Repository not found or not accessible." });
  });

  it("does not claim errors it did not raise", () => {
    expect(gitSourceHttpError(new Error("Command failed: git clone …"))).toBeUndefined();
  });
});
