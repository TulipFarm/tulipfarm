import { describe, expect, it } from "vitest";
import {
  filterItems,
  firstAgentMentionId,
  type MentionItem,
  type PMNode,
  serializeDoc,
} from "./serialize";

// Build a single-paragraph doc from inline nodes — mirrors `editor.getJSON()` shape.
function para(...inline: PMNode[]): PMNode {
  return { type: "doc", content: [{ type: "paragraph", content: inline }] };
}
const text = (t: string, marks?: PMNode["marks"]): PMNode => ({ type: "text", text: t, marks });
const mention = (nodeName: string, id: string, label = id): PMNode => ({
  type: nodeName,
  attrs: { id, label },
});

describe("serializeDoc — text + marks", () => {
  it("serializes plain text", () => {
    expect(serializeDoc(para(text("hello world"))).text).toBe("hello world");
  });

  it("wraps bold, italic, code, and strike marks as markdown", () => {
    expect(serializeDoc(para(text("b", [{ type: "bold" }]))).text).toBe("**b**");
    expect(serializeDoc(para(text("i", [{ type: "italic" }]))).text).toBe("*i*");
    expect(serializeDoc(para(text("c", [{ type: "code" }]))).text).toBe("`c`");
    expect(serializeDoc(para(text("s", [{ type: "strike" }]))).text).toBe("~~s~~");
  });

  it("renders a link as [text](href) for safe schemes", () => {
    const doc = para(text("docs", [{ type: "link", attrs: { href: "https://x.test" } }]));
    expect(serializeDoc(doc).text).toBe("[docs](https://x.test)");
    const mail = para(text("me", [{ type: "link", attrs: { href: "mailto:a@b.test" } }]));
    expect(serializeDoc(mail).text).toBe("[me](mailto:a@b.test)");
  });

  it("drops an unsafe link href, keeping the text unlinked", () => {
    const js = para(text("click", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]));
    expect(serializeDoc(js).text).toBe("click");
    const data = para(text("x", [{ type: "link", attrs: { href: "data:text/html,<b>" } }]));
    expect(serializeDoc(data).text).toBe("x");
  });

  it("nests code inside emphasis inside a link (stable order)", () => {
    const doc = para(
      text("x", [
        { type: "code" },
        { type: "bold" },
        { type: "link", attrs: { href: "https://u.test" } },
      ])
    );
    expect(serializeDoc(doc).text).toBe("[**`x`**](https://u.test)");
  });

  it("turns a hardBreak into a newline within a paragraph", () => {
    expect(serializeDoc(para(text("a"), { type: "hardBreak" }, text("b"))).text).toBe("a\nb");
  });

  it("joins multiple block paragraphs with a blank line", () => {
    const doc: PMNode = {
      type: "doc",
      content: [
        { type: "paragraph", content: [text("one")] },
        { type: "paragraph", content: [text("two")] },
      ],
    };
    expect(serializeDoc(doc).text).toBe("one\n\ntwo");
  });
});

describe("serializeDoc — mentions", () => {
  it("keeps mentions as literal @/ / /# tokens in the text", () => {
    const doc = para(
      mention("mentionAgent", "GeneralAssistant"),
      text(" create a "),
      mention("mentionResource", "tickets"),
      text(" with "),
      mention("mentionSkill", "copywriting")
    );
    expect(serializeDoc(doc).text).toBe("@GeneralAssistant create a #tickets with /copywriting");
  });

  it("sets agentId from the first @agent mention only", () => {
    const doc = para(
      mention("mentionAgent", "Triage"),
      text(" then "),
      mention("mentionAgent", "Second")
    );
    expect(serializeDoc(doc).agentId).toBe("Triage");
  });

  it("collects skill + resource ids, de-duplicated in order", () => {
    const doc = para(
      mention("mentionSkill", "copywriting"),
      mention("mentionResource", "tickets"),
      mention("mentionSkill", "copywriting"),
      mention("mentionResource", "invoices")
    );
    const out = serializeDoc(doc);
    expect(out.skills).toEqual(["copywriting"]);
    expect(out.resources).toEqual(["tickets", "invoices"]);
  });

  it("uses the label for the token but the id for the structured field", () => {
    const doc = para(mention("mentionAgent", "github-triage", "GithubTriage"));
    const out = serializeDoc(doc);
    expect(out.text).toBe("@GithubTriage");
    expect(out.agentId).toBe("github-triage");
  });

  it("returns empty arrays and undefined agentId for a plain message", () => {
    const out = serializeDoc(para(text("just text")));
    expect(out.agentId).toBeUndefined();
    expect(out.skills).toEqual([]);
    expect(out.resources).toEqual([]);
  });
});

describe("filterItems", () => {
  const items: MentionItem[] = [
    { id: "copywriting", label: "copywriting" },
    { id: "code-review", label: "code-review" },
    { id: "scope-guard", label: "scope-guard" },
  ];

  it("returns the head of the list (capped) for an empty query", () => {
    expect(filterItems("", items, 2)).toHaveLength(2);
  });

  it("ranks prefix matches above substring matches", () => {
    // "cop" is a prefix of copywriting; "scope" contains "cop" mid-string.
    const items2: MentionItem[] = [
      { id: "scope-guard", label: "scope-guard" },
      { id: "copywriting", label: "copywriting" },
    ];
    expect(filterItems("cop", items2).map((i) => i.id)).toEqual(["copywriting", "scope-guard"]);
  });

  it("is case-insensitive and drops non-matches", () => {
    expect(filterItems("CODE", items).map((i) => i.id)).toEqual(["code-review"]);
  });

  it("caps results to the limit", () => {
    expect(filterItems("co", items, 1)).toHaveLength(1);
  });
});

describe("firstAgentMentionId", () => {
  it("returns undefined for a plain message (no mentions)", () => {
    expect(firstAgentMentionId(para(text("just text")))).toBeUndefined();
  });

  it("returns the id of a lone @agent mention", () => {
    expect(firstAgentMentionId(para(mention("mentionAgent", "Billing")))).toBe("Billing");
  });

  it("returns the FIRST @agent mention when several are present", () => {
    const doc = para(mention("mentionAgent", "First"), mention("mentionAgent", "Second"));
    expect(firstAgentMentionId(doc)).toBe("First");
  });

  it("ignores skill/resource mentions and finds the agent among them", () => {
    const doc = para(
      mention("mentionSkill", "copywriting"),
      mention("mentionResource", "tickets"),
      mention("mentionAgent", "Triage")
    );
    expect(firstAgentMentionId(doc)).toBe("Triage");
  });

  it("returns undefined when only skill/resource mentions are present", () => {
    const doc = para(mention("mentionSkill", "copywriting"), mention("mentionResource", "tickets"));
    expect(firstAgentMentionId(doc)).toBeUndefined();
  });

  it("finds an agent mention in a later block", () => {
    const doc: PMNode = {
      type: "doc",
      content: [
        { type: "paragraph", content: [text("intro")] },
        { type: "paragraph", content: [mention("mentionAgent", "Second")] },
      ],
    };
    expect(firstAgentMentionId(doc)).toBe("Second");
  });
});
