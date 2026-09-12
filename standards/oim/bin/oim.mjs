#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runConformance } from "../src/conformance.mjs";
import { validateConformanceClaim, validatePackageDirectory } from "../src/index.mjs";

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "validate") {
    const directory = required(args[0], "usage: oim validate <package-directory>");
    const result = await validatePackageDirectory(directory);
    process.stdout.write(`${JSON.stringify({ valid: true, digest: result.digest }, null, 2)}\n`);
  } else if (command === "validate-claim") {
    const file = required(args[0], "usage: oim validate-claim <claim.json>");
    const claim = validateConformanceClaim(JSON.parse(await readFile(file, "utf8")));
    process.stdout.write(`${JSON.stringify(claim, null, 2)}\n`);
  } else if (command === "conformance") {
    const options = parseOptions(args);
    const adapterPath = required(
      options.adapter,
      "usage: oim conformance --adapter <module> --runtime <name@version> --profiles <list>"
    );
    const runtime = parseRuntime(required(options.runtime, "--runtime must be name@version"));
    const profiles = parseProfiles(required(options.profiles, "--profiles must include core=..."));
    const adapterModule = await import(pathToFileURL(resolve(adapterPath)).href);
    const adapter = adapterModule.default ?? adapterModule.adapter ?? adapterModule;
    const report = await runConformance({ runtime, profiles, adapter });
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) await writeFile(options.output, output);
    process.stdout.write(output);
  } else {
    throw new Error(
      "usage: oim <validate|validate-claim|conformance>; run with a command for details"
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`invalid option ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  return options;
}

function parseRuntime(value) {
  const separator = value.lastIndexOf("@");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error("--runtime must be name@version");
  }
  return { name: value.slice(0, separator), version: value.slice(separator + 1) };
}

function parseProfiles(value) {
  return Object.fromEntries(
    value.split(",").map((entry) => {
      const [profile, version, extra] = entry.split("=");
      if (!profile || !version || extra !== undefined) {
        throw new Error(`invalid profile ${entry}`);
      }
      return [profile, version];
    })
  );
}
