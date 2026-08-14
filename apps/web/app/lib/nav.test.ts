import { expect, test } from "vitest";
import { MODE_SECTIONS, type NavItem, titleForPath } from "./nav";

function everyNavItem(): NavItem[] {
  return Object.values(MODE_SECTIONS).flatMap((sections) =>
    sections.flatMap((section) => section.items)
  );
}

/* New nav items must update `PAGE_META`; otherwise the fallback silently labels them Chat. */
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

/* `/business/people` redirects in-shell, so its transient label must stay explicit. */
test("a retired page still names its destination while it redirects", () => {
  expect(titleForPath("/business/people")).toBe(titleForPath("/business/access"));
});
