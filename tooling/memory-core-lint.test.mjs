import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the actual lint configuration fences the core without restricting host adapters', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tulip-memory-lint-'));
  try {
    const config = JSON.parse(await readFile(path.join(root, '.oxlintrc.json'), 'utf8'));
    config.jsPlugins = [
      fileURLToPath(import.meta.resolve('@shadcn/lint')),
      path.join(root, 'tooling/design-system-lint.mjs'),
    ];
    await writeFile(path.join(directory, '.oxlintrc.json'), JSON.stringify(config));
    const cases = [
      ['valid', 'import { z } from "zod"; export const schema = z.string();', false],
      ['node-api', 'export const executable = process.execPath;', false],
      ['process-destructure', 'const { "execPath": executable } = process; export { executable };', false],
      ['process-api', 'import runtime from "node:process"; export const executable = runtime.execPath;', false],
      ['relative', 'export * from "./contracts/knowledge.js";', false],
      ['parent-inside', 'export * from "../contracts/knowledge.js";', false],
      ['data', 'export const label = "@tulipfarm/access";', false],
      ['host', 'import "@tulipfarm/access";', true],
      ['host-subpath', 'import "@tulipfarm/config/knowledge-embeddings";', true],
      ['self', 'import "@tulipfarm/memory-core";', true],
      ['pg', 'import "pg";', true],
      ['pg-subpath', 'import "pg/lib/client";', true],
      ['pg-native', 'import "pg-native";', true],
      ['temporal', 'import "@temporalio/worker";', true],
      ['temporal-subpath', 'export * from "@temporalio/client/lib";', true],
      ['reexport', 'export { value } from "@tulipfarm/config";', true],
      ['type', 'import type { Actor } from "@tulipfarm/access"; export type Value = Actor;', true],
      ['type-expression', 'export type Value = import("@tulipfarm/access").Actor;', true],
      ['import-equals', 'import host = require("@tulipfarm/access"); export { host };', true],
      ['dynamic', 'export const host = import("@tulipfarm/access");', true],
      ['dynamic-template', 'export const host = import(`@tulipfarm/access`);', true],
      ['dynamic-computed', 'export const load = name => import(name);', true],
      ['require', 'export const host = require("pg");', true],
      ['require-alias', 'const load = require; export const host = load("pg");', true],
      ['require-concat', 'export const host = require("@tulipfarm/" + "access");', true],
      [
        'create-require',
        'import { createRequire as factory } from "node:module"; const load = factory(import.meta.url); export const host = load("pg");',
        true,
      ],
      ['module-require', 'export const host = module.require("pg");', true],
      ['env', 'export const value = process.env.KEY;', true],
      ['env-computed', 'export const value = process["env"]["KEY"];', true],
      ['env-concat', 'export const value = process["en" + "v"];', true],
      ['env-optional', 'export const value = process?.["env"]?.KEY;', true],
      ['env-destructure', 'const { env: settings } = process; export { settings };', true],
      ['env-alias', 'const runtime = process; export const value = runtime.env;', true],
      ['env-import', 'import { env as settings } from "node:process"; export { settings };', true],
      ['env-process-import', 'import runtime from "process"; export const value = runtime.env;', true],
      [
        'env-process-default',
        'import { default as runtime } from "node:process"; export const value = runtime.env;',
        true,
      ],
      ['env-process-namespace', 'import * as runtime from "node:process"; export const value = runtime.env;', true],
      ['env-require', 'export const value = require("node:process").env;', true],
      ['env-global', 'export const value = globalThis.process.env;', true],
      ['env-reexport', 'export { env as settings } from "node:process";', true],
      ['env-export-all', 'export * from "node:process";', true],
      ['env-import-meta', 'export const value = import.meta.env;', true],
      ['escape', 'export * from "../../../knowledge/src/contracts.js";', true],
      ['absolute', 'export * from "/workspace/packages/knowledge/src/contracts.js";', true],
      ['file-url', 'export * from "file:///workspace/packages/knowledge/src/contracts.js";', true],
    ];
    for (const [name, source, rejected] of cases) {
      const filename = path.join(directory, 'packages/memory-core/src/test', `${name}.ts`);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, source);
      const result = spawnSync(
        process.execPath,
        [
          path.join(root, 'node_modules/oxlint/bin/oxlint'),
          '--config',
          path.join(directory, '.oxlintrc.json'),
          filename,
        ],
        { cwd: directory, encoding: 'utf8' },
      );
      const output = result.stdout + result.stderr;
      assert.equal(result.status, rejected ? 1 : 0, `${name}: ${output}`);
      if (rejected) assert.match(output, /memory-core-boundary/, `${name}: ${output}`);
    }
    const host = path.join(directory, 'packages/knowledge/src/host.ts');
    await mkdir(path.dirname(host), { recursive: true });
    await writeFile(host, 'import "@tulipfarm/access"; import "pg"; export const value = process.env.KEY;');
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'node_modules/oxlint/bin/oxlint'), '--config', path.join(directory, '.oxlintrc.json'), host],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
