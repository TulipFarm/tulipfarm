/**
 * Egress smoke check for the probe fixture.
 *
 * Runs the real {@link DockerNetworkEgressPort} the Worker wires, then executes
 * `probe-network.sh` under the same container flags the executor uses. It asserts both halves of
 * the contract: a declared destination is reachable with curl *and* wget, and an undeclared one is
 * refused. Proving only the reachable half would let a wide-open allowlist pass as working egress.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerNetworkEgressPort } from "../../../packages/sandbox/src/development-egress";

const here = dirname(fileURLToPath(import.meta.url));
const image = process.argv[2];
if (image === undefined || image.length === 0) {
  console.error("usage: egress-check.mts <repository@sha256:...>");
  process.exit(2);
}

function docker(args: readonly string[], timeoutMs = 120_000) {
  return new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
    const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        out: Buffer.concat(out).toString(),
        err: Buffer.concat(err).toString(),
      });
    });
  });
}

async function main(): Promise<number> {
  const port = new DockerNetworkEgressPort({ image });
  let failures = 0;
  try {
    const egress = await port.prepare(["example.com"]);
    console.log(`  network ${egress.networkName}  proxy ${egress.httpsProxy}`);

    const work = await mkdtemp(join(tmpdir(), "tulip-egress-check-"));
    await mkdir(join(work, "input/entrypoint"), { recursive: true });
    await mkdir(join(work, "input/artifacts"), { recursive: true });
    await mkdir(join(work, "output"), { recursive: true });
    const entrypoint = "probe-network.sh";
    await writeFile(
      join(work, "input/entrypoint", entrypoint),
      await readFile(join(here, "soul/skills/skill-runtime-probe/scripts", entrypoint), "utf8"),
      { mode: 0o555 }
    );
    await writeFile(join(work, "input/artifacts/0-input.json"), '{"host":"example.com"}');
    await chmod(join(work, "output"), 0o777);

    const run = await docker([
      "run",
      "--rm",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      `--network=${egress.networkName}`,
      "--env=TULIP_INPUT_DIR=/tulip/input/artifacts",
      "--env=TULIP_OUTPUT_DIR=/tulip/output",
      `--env=HTTPS_PROXY=${egress.httpsProxy}`,
      `--env=HTTP_PROXY=${egress.httpsProxy}`,
      `--env=https_proxy=${egress.httpsProxy}`,
      `--env=http_proxy=${egress.httpsProxy}`,
      "--tmpfs=/tmp:rw,noexec,nosuid,size=16777216",
      `--mount=type=bind,source=${work}/input,target=/tulip/input,readonly`,
      `--mount=type=bind,source=${work}/output,target=/tulip/output`,
      image,
      "bash",
      `/tulip/input/entrypoint/${entrypoint}`,
    ]);
    if (run.code !== 0) {
      console.error(`  probe-network.sh exited ${run.code}: ${run.err.trim()}`);
      return 1;
    }
    const result = JSON.parse(await readFile(join(work, "output/result.json"), "utf8"));
    console.log(`  probe-network.sh -> ${JSON.stringify(result)}`);
    if (result.curl?.status !== "200") {
      console.error("  FAIL curl did not reach the declared destination");
      failures++;
    }
    if (result.wget?.bytes === "unavailable") {
      console.error("  FAIL wget did not reach the declared destination");
      failures++;
    }
    if (result.undeclaredDestination !== "refused") {
      console.error("  FAIL an undeclared destination was reachable");
      failures++;
    }
  } finally {
    await port.close();
  }
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
