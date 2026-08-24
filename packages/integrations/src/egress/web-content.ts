/// <reference path="../types/turndown-plugin-gfm.d.ts" />
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/**
 * Turning a fetched response into something a model can read, and nothing more.
 *
 * This module renders; it never summarises. A Tool that called a model to shrink its own result
 * would decide, inside the effect path, which parts of an untrusted page the Agent is allowed to
 * consider — a second, unaudited model call with no Run event, no spend record and no way for the
 * Agent to ask a follow-up question of the same bytes. Rendering is deterministic and replayable,
 * so it belongs here; distillation is a runtime concern and belongs to the Turn.
 */

/** What the rendered text is, so a reader knows whether structure survived. */
export type WebContentFormat = "markdown" | "json" | "text";

/** One link the page carried, kept so a distiller can cite and an Agent can navigate. */
export interface WebContentLink {
  readonly text: string;
  readonly href: string;
}

export interface RenderedWebContent {
  readonly format: WebContentFormat;
  readonly text: string;
  /** Absolute, https-only, de-duplicated, and capped. */
  readonly links: readonly WebContentLink[];
}

/**
 * How many links travel with a page.
 *
 * A navigation-heavy page carries hundreds, and every one is attacker-chosen text that costs
 * prompt budget. The cap is on the extracted list rather than the page, so the text stays whole.
 */
const MAX_LINKS = 50;
const MAX_LINK_TEXT = 120;

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

/**
 * Elements dropped whole, because their text is code, markup or chrome rather than prose.
 *
 * `script` and `style` matter most: turndown's default emits their text content verbatim, so a
 * page can park an instruction inside one and have it read as page copy by anything downstream.
 */
const DROPPED_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
  "canvas",
  "form",
  "head",
  "link",
  "meta",
  "base",
];

/**
 * The only tree shape this module needs from turndown's DOM.
 *
 * Declared here rather than pulled in with the `dom` lib: this is a server package, and adding
 * the browser globals to it so that three callbacks can be typed would put `window` and friends
 * in scope for every file that follows.
 */
interface HtmlNode {
  readonly nodeName: string;
  readonly parentElement: HtmlNode | null;
  getAttribute(name: string): string | null;
}

const HIDDEN_STYLE = /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)\s*(;|$)/i;

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const point = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(point) && point > 0 ? safeCodePoint(point) : " ";
    }
    if (code.startsWith("#")) {
      const point = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 ? safeCodePoint(point) : " ";
    }
    return HTML_ENTITIES[code.toLowerCase()] ?? entity;
  });
}

/** An out-of-range code point throws from `fromCodePoint`; a page must not be able to do that. */
function safeCodePoint(point: number): string {
  if (point > 0x10ffff) return " ";
  try {
    return String.fromCodePoint(point);
  } catch {
    return " ";
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Absolute https URLs only, resolved against the page.
 *
 * A `javascript:` or `data:` href is not a destination an Agent could fetch, and carrying one
 * into the prompt only offers a string that looks actionable and is not.
 */
function absoluteHref(href: string, baseUrl: string | undefined): string | undefined {
  try {
    const url = baseUrl === undefined ? new URL(href) : new URL(href, baseUrl);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** An element the page renders to nobody, which is where text meant only for a machine lives. */
function isHidden(node: HtmlNode): boolean {
  if (node.getAttribute("hidden") !== null) return true;
  return HIDDEN_STYLE.test(node.getAttribute("style") ?? "");
}

/**
 * Whether a node sits anywhere under something the reader never sees.
 *
 * Needed because turndown renders children before their parent, so a rule that discards a hidden
 * block still runs the rules of everything inside it first. The text is dropped either way, but a
 * side effect — collecting a link — would already have happened, and a hidden `<a>` would reach
 * the Agent through the link list without ever appearing in the page it supposedly came from.
 */
function isConcealed(node: HtmlNode): boolean {
  for (let current: HtmlNode | null = node; current !== null; current = current.parentElement) {
    if (isHidden(current)) return true;
    if (DROPPED_ELEMENTS.includes(current.nodeName.toLowerCase())) return true;
  }
  return false;
}

/**
 * A turndown instance bound to one page, because link collection is per-render state.
 *
 * Rules added last are matched first, so the hidden-element rule is registered after the others
 * and wins over them. It has to be a rule rather than `remove()`: turndown consults its built-in
 * rules before its removal filters, so `remove()` never fires for an element it already knows how
 * to render — a `<p hidden>` would be removed in principle and rendered in practice.
 */
function renderer(
  baseUrl: string | undefined,
  collect: (link: WebContentLink) => void
): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    hr: "---",
    emDelimiter: "*",
  });
  service.use(gfm);
  service.remove(DROPPED_ELEMENTS as unknown as Parameters<TurndownService["remove"]>[0]);

  service.addRule("absoluteLinks", {
    filter: "a",
    replacement: (content: string, node: unknown) => {
      const element = node as HtmlNode;
      const label = collapse(content);
      const rawHref = element.getAttribute("href");
      if (rawHref === null) return label;
      const href = absoluteHref(rawHref, baseUrl);
      if (href === undefined) return label;
      if (!isConcealed(element)) collect({ text: label.slice(0, MAX_LINK_TEXT) || href, href });
      return label.length === 0 ? href : `[${label}](${href})`;
    },
  });

  service.addRule("altTextOnly", {
    filter: "img",
    replacement: (_content: string, node: unknown) => {
      const alt = collapse((node as HtmlNode).getAttribute("alt") ?? "");
      return alt.length === 0 ? "" : `![${alt}]`;
    },
  });

  service.addRule("stripHidden", {
    filter: (node: unknown) => isHidden(node as HtmlNode),
    replacement: () => "",
  });

  return service;
}

/** Elements whose text is never page copy, removed with their content rather than unwrapped. */
const OPAQUE_BLOCKS = /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * Reduces HTML to readable text without parsing it, for markup no parser would accept.
 *
 * Opaque elements go first and whole. Removing tags alone keeps whatever sat between them, so a
 * page could hand back its scripts as prose — the one thing this module must never do.
 */
export function htmlToPlainText(html: string): string {
  return collapse(decodeHtmlEntities(html.replace(OPAQUE_BLOCKS, " ").replace(/<[^>]+>/g, " ")));
}

/**
 * Renders HTML as Markdown, preserving the structure a reader needs to judge and cite a page.
 *
 * Structure is the point: a flat wall of words loses which sentence was a heading and which was
 * body, and a citation into it cannot be checked. Parsing is turndown's — hand-rolled tag
 * matching cannot see that a block is hidden, because that is a property of the tree rather than
 * of any one tag.
 */
export function htmlToMarkdown(
  html: string,
  baseUrl?: string
): { readonly text: string; readonly links: readonly WebContentLink[] } {
  const links: WebContentLink[] = [];
  const seenHref = new Set<string>();
  const collect = (link: WebContentLink) => {
    if (seenHref.has(link.href) || links.length >= MAX_LINKS) return;
    seenHref.add(link.href);
    links.push(link);
  };

  let text: string;
  try {
    text = renderer(baseUrl, collect).turndown(html);
  } catch {
    // A page is untrusted input; malformed markup must degrade to plain text, never throw.
    text = htmlToPlainText(html);
  }

  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), links };
}

/**
 * The readable form of one response, by content type.
 *
 * `JSON.stringify(undefined)` is `undefined` rather than a string, so an empty or failed response
 * would otherwise return a non-string from a `string`-shaped field and break every caller that
 * slices it.
 */
export function renderWebContent(
  contentType: string | undefined,
  body: unknown,
  baseUrl?: string
): RenderedWebContent {
  const normalized = contentType?.toLowerCase() ?? "";
  const raw = typeof body === "string" ? body : (JSON.stringify(body, null, 2) ?? "");

  if (normalized.includes("text/html") || normalized.includes("application/xhtml+xml")) {
    const { text, links } = htmlToMarkdown(raw, baseUrl);
    return { format: "markdown", text, links };
  }
  if (normalized.includes("markdown")) return { format: "markdown", text: raw, links: [] };
  if (typeof body !== "string" || normalized.includes("json")) {
    return { format: "json", text: raw, links: [] };
  }
  return { format: "text", text: raw, links: [] };
}
