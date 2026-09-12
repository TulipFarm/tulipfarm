import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SoulLoader } from "./published-loader";

const ROOT = join(import.meta.dirname, "__oim_loader_test__");

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

beforeEach(() => mkdir(ROOT, { recursive: true }));
afterEach(() => rm(ROOT, { recursive: true, force: true }));

describe("SoulLoader OIM packages", () => {
  it("loads oim.yml and its declared runtime companions", async () => {
    await write(
      join(ROOT, "integrations", "tasks", "oim.yml"),
      `oimVersion: "1.0"
kind: Integration
metadata:
  id: tasks
  name: Tasks
  version: 1.0.0
  description: Read tasks.
  license: Apache-2.0
profiles:
  core: "1.0"
  knowledge: "1.0"
operations:
  - id: list-tasks
    name: list_tasks
    description: List tasks.
    effect: read
    identityMode: shared_only
    source:
      type: graphql
      url: https://api.tasks.example/graphql
      operation: ListTasks
      documentFile: list-tasks.graphql
    requestSchema:
      type: object
      additionalProperties: false
      properties:
        item_id:
          type: string
    response:
      schema:
        type: object
      maxBytes: 16384
files:
  - path: list-tasks.graphql
    role: graphql
    sha256: "${"0".repeat(64)}"
  - path: fixtures.yml
    role: fixture
    sha256: "${"1".repeat(64)}"
  - path: normalize.js
    role: hook
    sha256: "${"2".repeat(64)}"
  - path: knowledge.md
    role: guide
    sha256: "${"3".repeat(64)}"
knowledge:
  sourceKinds:
    - id: task
      label: Task
  list:
    operationId: list-tasks
    itemsPointer: /data/tasks
    mapping:
      itemId: /id
    cursor:
      kind: none
  content:
    operationId: list-tasks
    itemParameter: item_id
    mapping:
      content: /body
  acl:
    mode: item
    operationId: list-tasks
    itemParameter: item_id
    entriesPointer: /acl
    entry:
      defaultKind: user
      providerUserId: /id
  deletion:
    kind: absent_from_full_list
  guideFile: knowledge.md
`
    );
    await write(
      join(ROOT, "integrations", "tasks", "list-tasks.graphql"),
      "query ListTasks { tasks { id } }\n"
    );
    await write(join(ROOT, "integrations", "tasks", "fixtures.yml"), "version: 1\ncases: []\n");
    await write(
      join(ROOT, "integrations", "tasks", "normalize.js"),
      "export function normalize(input) { return input; }\n"
    );
    await write(join(ROOT, "integrations", "tasks", "knowledge.md"), "# Tasks\n");
    const loader = new SoulLoader(ROOT, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    await loader.load();

    expect(loader.integrations.get("tasks")).toMatchObject({
      slug: "tasks",
      sourceIntegration: "tasks",
      oimManifest: { metadata: { id: "tasks" } },
      oimDocuments: { "list-tasks.graphql": "query ListTasks { tasks { id } }\n" },
      oimFixtures: { "fixtures.yml": "version: 1\ncases: []\n" },
      oimPackageFiles: {
        "list-tasks.graphql": "query ListTasks { tasks { id } }\n",
        "fixtures.yml": "version: 1\ncases: []\n",
        "normalize.js": "export function normalize(input) { return input; }\n",
        "knowledge.md": "# Tasks\n",
      },
      knowledgeGuide: "# Tasks\n",
    });
  });

  it("refuses competing legacy and OIM declarations", async () => {
    await write(
      join(ROOT, "integrations", "tasks", "oim.yml"),
      "oimVersion: '1.0'\nkind: Integration\n"
    );
    await write(
      join(ROOT, "integrations", "tasks", "manifest.yml"),
      "name: Tasks\negress:\n  type: none\n"
    );
    const loader = new SoulLoader(ROOT, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    await expect(loader.load()).rejects.toThrow(/oim\.yml and manifest\.yml/);
  });
});
