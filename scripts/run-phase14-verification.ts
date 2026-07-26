import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  type Phase14VerificationRecord,
  type VerificationComponents,
  verifyPhase14Record,
} from "../ops/verification/phase14.ts";
import {
  assertValidPhase14RunId,
  runPhase14Verification,
  type VerificationCommandPlan,
} from "../ops/verification/runner.ts";

interface PlanFile {
  readonly runId: string;
  readonly components: VerificationComponents;
  readonly commands: readonly VerificationCommandPlan[];
}

const root = resolve(import.meta.dirname, "..");

function usage(): never {
  throw new Error(
    "usage: pnpm verify:phase14 -- <plan.json> [evidence-directory]\n" +
      "The evidence directory defaults to .phase14-evidence/<runId>."
  );
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid verification plan field: ${field}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid verification plan field: ${field}`);
  }
  return value;
}

function parsePlan(value: unknown): PlanFile {
  const input = object(value, "root");
  const components = object(input.components, "components");
  if (!Array.isArray(input.commands)) {
    throw new Error("invalid verification plan field: commands");
  }
  const runId = text(input.runId, "runId");
  assertValidPhase14RunId(runId);
  return {
    runId,
    components: {
      api: text(components.api, "components.api"),
      worker: text(components.worker, "components.worker"),
      integrationWorker: text(components.integrationWorker, "components.integrationWorker"),
    },
    commands: input.commands.map((entry, index) => {
      const command = object(entry, `commands[${index}]`);
      if (!Array.isArray(command.command)) {
        throw new Error(`invalid verification plan field: commands[${index}].command`);
      }
      return {
        id: text(command.id, `commands[${index}].id`) as VerificationCommandPlan["id"],
        command: command.command.map((part, partIndex) =>
          text(part, `commands[${index}].command[${partIndex}]`)
        ),
      };
    }),
  };
}

function gitObject(revision: string): string {
  const result = spawnSync("git", ["rev-parse", revision], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`cannot resolve repository revision: ${revision}`);
  }
  return result.stdout.trim();
}

async function execute(
  command: VerificationCommandPlan,
  evidenceDirectory: string
): Promise<{ exitCode: number; outputSha256: string; evidenceRef: string }> {
  const logPath = resolve(evidenceDirectory, `${command.id}.log`);
  const log = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
  const hash = createHash("sha256");
  const [executable, ...args] = command.command;
  if (executable === undefined) throw new Error(`empty command for ${command.id}`);

  const exitCode = await new Promise<number>((resolveExit) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      log.write(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      log.write(chunk);
      process.stderr.write(chunk);
    });
    child.once("error", (error) => {
      const message = `command could not start: ${error.name}\n`;
      hash.update(message);
      log.write(message);
      resolveExit(127);
    });
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  await new Promise<void>((resolveClose, reject) => {
    log.end(resolveClose);
    log.once("error", reject);
  });
  return {
    exitCode,
    outputSha256: hash.digest("hex"),
    evidenceRef: relative(root, logPath),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const planPath = args[0];
  if (planPath === undefined) usage();
  const plan = parsePlan(JSON.parse(readFileSync(resolve(root, planPath), "utf8")) as unknown);
  const evidenceDirectory = resolve(root, args[1] ?? `.phase14-evidence/${plan.runId}`);
  await mkdir(dirname(evidenceDirectory), { recursive: true, mode: 0o700 });
  await mkdir(evidenceDirectory, { recursive: false, mode: 0o700 });

  const repository = {
    commitSha: gitObject("HEAD"),
    treeSha: gitObject("HEAD^{tree}"),
  };
  const record = await runPhase14Verification(
    {
      runId: plan.runId,
      repository,
      components: plan.components,
      commands: plan.commands,
    },
    {
      execute: (command) => execute(command, evidenceDirectory),
    }
  );
  const manifestPath = resolve(evidenceDirectory, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  verifyPhase14Record(record, {
    ...repository,
    components: plan.components,
    commands: plan.commands,
  });
  process.stdout.write(`Phase 14 verification passed: ${relative(root, manifestPath)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown verification failure";
  process.stderr.write(`Phase 14 verification failed: ${message}\n`);
  process.exitCode = 1;
});

export type { Phase14VerificationRecord };
