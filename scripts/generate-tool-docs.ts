/**
 * Regenerates the public Tool catalog page from the Tool registry the API actually builds, then
 * exits. Wired into `apps/docs` `build` and `dev`, and re-run by `scripts/docs-tool-catalog.test.ts`
 * so a Tool added, renamed or re-described in source cannot leave the page saying otherwise.
 *
 * A catalog page was refused until now because a hand-typed one rots. Nothing here is typed by
 * hand: names, summaries, mutation flags and the grouping all come from `buildToolRegistry`, and
 * the sections are the same authorization areas the access screen groups by.
 *
 * Integration Tools (GitHub, Slack, Google, network) are excluded by construction — they are
 * arguments to `buildToolRegistry` and are simply not passed here — because they exist only once an
 * operator connects that provider, so no fixed list is true of every instance.
 */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SURFACE_TOOLS } from "../apps/api/src/surfaces/tools";
import { buildToolRegistry } from "../apps/api/src/tools/setup";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(REPO_ROOT, "apps/docs/content/docs/reference/tool-catalog.mdx");

interface Section {
  /** First segment of the authorization action, which is what the access screen groups by. */
  readonly area: string;
  readonly heading: string;
  readonly intro: string;
}

/**
 * Reading order, and the only hand-written prose about a group. A Tool whose area is missing here
 * fails the build rather than publishing a headless section. `areaLabel` from the access screen is
 * deliberately not reused: it title-cases one action segment, so it yields headings like "File".
 */
const SECTIONS: readonly Section[] = [
  {
    area: "record",
    heading: "Business data",
    intro: "Reading and changing the records your resource types describe.",
  },
  {
    area: "soul",
    heading: "Your instance's own setup",
    intro:
      "Changing the soul — the git-backed definitions of what your instance is and what it can do.",
  },
  {
    area: "knowledge",
    heading: "The knowledge base",
    intro: "Searching, reading and writing the cited pages agents answer from.",
  },
  {
    area: "memory",
    heading: "What an agent remembers about you",
    intro: "The single document an agent carries between chats with you.",
  },
  {
    area: "kv",
    heading: "Saved values",
    intro: "Short-lived values an agent stores for itself. Not business data, and not memory.",
  },
  {
    area: "file",
    heading: "Files",
    intro: "Documents an agent can read, or produce for you to open, download and forward.",
  },
  {
    area: "platform",
    heading: "Delegating and automating",
    intro: "How work is handed to another agent, automated, and reported on while it runs.",
  },
  {
    area: "task",
    heading: "Work handed back to a person",
    intro: "Raising, and closing, work the runtime needs a human to do.",
  },
  {
    area: "frontend",
    heading: "Moving around the app",
    intro: "Reading and moving the screen you are on. Only ever offered in the browser.",
  },
];

/** Areas the reader is served better elsewhere, and the page that serves them. */
const ELSEWHERE: Readonly<Record<string, string>> = {
  surface: "/docs/using-tulipfarm/surfaces",
};

/**
 * Internal words for things the docs already have a reader-facing word for. Summaries are lifted
 * from model-facing text, which is written in the internal vocabulary, so this swap keeps the page
 * inside `metadata/terminologies.md` without anyone hand-rewriting a summary.
 */
const DOCS_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\broutine execution\b/gi, "routine run"],
  [/\bconversations\b/g, "chats"],
  [/\bconversation\b/g, "chat"],
];

/** Abbreviations whose period ends no sentence; without these a summary is cut mid-clause. */
const ABBREVIATIONS = /(?:e\.g|i\.e|etc|vs|approx|no)$/i;

interface CatalogTool {
  readonly name: string;
  readonly area: string;
  readonly mutating: boolean;
  readonly summary: string;
}

/**
 * The opening sentence of a Tool's model-facing description. Later sentences instruct the model
 * ("call this before…", "`definition` MUST be…") and read as orders to the reader, so they are
 * dropped rather than reworded — rewording is the drift a generator exists to prevent.
 */
export function firstSentence(description: string): string {
  const opening = (description.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  for (const match of opening.matchAll(/[.!?](?=\s)/g)) {
    if (ABBREVIATIONS.test(opening.slice(0, match.index))) continue;
    return opening.slice(0, match.index + 1);
  }
  return opening.endsWith(".") ? opening : `${opening}.`;
}

/** MDX reads a cell as markdown, so a pipe splits the row and a brace opens a JS expression. */
export function escapeCell(value: string): string {
  return value
    .replace(/\|/g, "\\|")
    .replace(/[{}<>]/g, (character) => `&#${character.charCodeAt(0)};`);
}

export function toDocsWords(value: string): string {
  return DOCS_WORDS.reduce((text, [pattern, word]) => text.replace(pattern, word), value);
}

/** Every non-integration Tool the API registers, with the area its authorization declares. */
export function collectTools(): CatalogTool[] {
  // Handlers close over these; the catalog reads declarations only, so mere presence is enough to
  // make each family register.
  const present = {} as never;
  const registry = buildToolRegistry({
    memoryDocuments: present,
    kv: present,
    files: present,
    knowledge: present,
    knowledgePageGate: present,
    knowledgeDenialSink: present,
    resources: present,
    resourceTypes: present,
    agentTools: present,
    skillTools: present,
    surfaceComponents: present,
    platform: present,
    tasks: present,
  });

  const known = new Set(SECTIONS.map((section) => section.area));
  const rendering = new Set(SURFACE_TOOLS.map((tool) => tool.name));
  const tools: CatalogTool[] = [];
  for (const tool of registry.getAll()) {
    if (rendering.has(tool.name)) continue;
    const action = tool.definition?.authorization?.action;
    if (action === undefined) {
      throw new Error(
        `Tool "${tool.name}" declares no authorization action, so the catalog cannot place it. ` +
          "Give its definition one, or exclude it here deliberately."
      );
    }
    const area = action.split(".")[0] ?? action;
    if (area in ELSEWHERE) continue;
    if (!known.has(area)) {
      throw new Error(
        `Tool area "${area}" (from "${tool.name}") has no entry in SECTIONS. Add a heading and ` +
          "intro for it, or route it to ELSEWHERE."
      );
    }
    tools.push({
      name: tool.name,
      area,
      mutating: tool.mutating,
      summary: toDocsWords(firstSentence(tool.definition.description)),
    });
  }
  return tools;
}

export function renderPage(tools: readonly CatalogTool[]): string {
  const sections = SECTIONS.filter((section) =>
    tools.some((tool) => tool.area === section.area)
  ).map((section) => {
    const rows = tools
      .filter((tool) => tool.area === section.area)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (tool) =>
          `| \`${tool.name}\` | ${tool.mutating ? "Yes" : "No"} | ${escapeCell(tool.summary)} |`
      );
    return [
      `## ${section.heading}`,
      "",
      section.intro,
      "",
      "| Tool | Changes things | What it does |",
      "| --- | --- | --- |",
      ...rows,
      "",
    ].join("\n");
  });

  return `---
title: Tool catalog
description: Every built-in tool an agent can call, grouped the way your access screen groups them, with what each does and whether it changes anything.
---

{/* Generated by scripts/generate-tool-docs.ts from the tool registry. Do not edit by hand. */}

A **tool** is one callable action an agent asks TulipFarm to run — reading a record, writing a
page, starting a routine. Every instance builds the same set of built-in tools at startup, and this
page is generated from that set, so it cannot drift from what your instance offers.

Appearing here is not permission. Every call is checked again against the agent's own limits and
the caller's access, and a tool an agent may not use is never offered to it. See
[what agents can do](/docs/using-tulipfarm/what-agents-can-do) for how that reads from the outside,
and [roles and permissions](/docs/reference/roles-and-permissions) for how the checking works.

**Changes things** marks a tool that writes something. Every other tool only looks.

Two groups are deliberately missing. Tools for a connected app arrive with the app, so they are
listed per provider under [bundled integrations](/docs/reference/bundled-integrations). Tools that
draw a reply on screen are explained in [surfaces](/docs/using-tulipfarm/surfaces).

${sections.join("\n")}
## Where your own list lives

This page covers what ships with TulipFarm. Your instance also holds whatever integrations you have
connected, so it is the only complete answer. **Operate → Business → People & access** shows that
live list, grouped into the same areas, with the tool names behind each entry.
`;
}

export function generateToolDocs(): number {
  const tools = collectTools();
  writeFileSync(PAGE, renderPage(tools));
  return tools.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`generated the Tool catalog page from ${generateToolDocs()} registered Tool(s)`);
}
