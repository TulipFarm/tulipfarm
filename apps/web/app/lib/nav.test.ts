import { expect, test } from "vitest";
import { MODE_SECTIONS, type NavItem, titleForPath } from "./nav";

function everyNavItem(): NavItem[] {
  return Object.values(MODE_SECTIONS).flatMap((sections) =>
    sections.flatMap((section) => section.items)
  );
}

/*
 * `PAGE_META` is a hand-ordered list that has to be extended whenever a page is added, and its
 * fallback is `/chat`. So a new nav item with no entry does not fail loudly — the top bar just
 * quietly calls the page "Chat". That is exactly how `/business/access` shipped mislabelled.
 * Asserting the two lists agree turns a silent wrong label into a failing test.
 */
test("every page reachable from the sidebar has its own title in the top bar", () => {
  const mislabelled = everyNavItem()
    .filter((item) => item.to !== "/chat" && titleForPath(item.to) === "Chat")
    .map((item) => item.to);

  expect(mislabelled).toEqual([]);
});

test("a nav item's declared label is the one the top bar shows", () => {
  const disagreements = everyNavItem()
    .map((item) => ({ to: item.to, nav: item.label, topBar: titleForPath(item.to) }))
    .filter((row) => row.nav !== row.topBar);

  expect(disagreements).toEqual([]);
});

test("a child route keeps its parent page's identity", () => {
  expect(titleForPath("/business/access/teams")).toBe("People & access");
  expect(titleForPath("/business/access/check")).toBe("People & access");
});

/*
 * `/business/people` merged into `/business/access` and now redirects. The redirect renders inside
 * the app shell for a frame, so an entry missing here would flash "Chat" at exactly the moment the
 * reader is looking for where their bookmark went.
 */
test("a retired page still names its destination while it redirects", () => {
  expect(titleForPath("/business/people")).toBe(titleForPath("/business/access"));
});
