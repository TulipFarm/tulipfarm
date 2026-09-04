import { expect, test } from "vitest";
import {
  isSettingsPath,
  type NavItem,
  SETTINGS_GROUPS,
  SIDEBAR_GROUPS,
  sectionForPath,
  titleForPath,
  visibleSettingsGroups,
  visibleSettingsItem,
  visibleSidebarGroups,
} from "./nav";

function everyNavItem(): NavItem[] {
  return [...SIDEBAR_GROUPS, ...SETTINGS_GROUPS].flatMap((group) => group.items);
}

/* New nav items must update `PAGE_META`; otherwise the fallback silently labels them Chat. */
test("every page reachable from the sidebar has its own title in the top bar", () => {
  const mislabelled = everyNavItem()
    .filter((item) => titleForPath(item.to) === "Chat")
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

test("identifies every route that swaps the app sidebar into Settings mode", () => {
  for (const path of [
    "/settings",
    "/settings/profile",
    "/business/models",
    "/business/access/teams",
    "/integrations/github",
    "/operations",
    "/design-guide",
  ]) {
    expect(isSettingsPath(path)).toBe(true);
  }
  for (const path of ["/", "/resources", "/business/activities", "/farm"]) {
    expect(isSettingsPath(path)).toBe(false);
  }
});

/* `/business/people` redirects in-shell, so its transient label must stay explicit. */
test("a retired page still names its destination while it redirects", () => {
  expect(titleForPath("/business/people")).toBe(titleForPath("/business/access"));
});

test("hides every denied destination and collapses its empty groups", () => {
  expect(visibleSidebarGroups({ isDev: false, visiblePaths: ["/business/activities"] })).toEqual([
    expect.objectContaining({
      heading: "Work",
      items: [
        expect.objectContaining({ label: "Chats" }),
        expect.objectContaining({ label: "Activity" }),
      ],
    }),
  ]);
});

/* Chat is the product's floor: an account granted nothing still has somewhere to be. */
test("keeps Chat reachable for an account granted nothing", () => {
  const groups = visibleSidebarGroups({ isDev: false, visiblePaths: [] });

  expect(groups.flatMap((group) => group.items).map((item) => item.to)).toEqual(["/chats"]);
});

/*
 * Settings is a door, not a page. Offering it to someone with nothing behind it hands them a room
 * they are not allowed to enter.
 */
test("hides Settings when nothing behind it is reachable", () => {
  const item = (paths: string[]) => visibleSettingsItem({ isDev: false, visiblePaths: paths });

  expect(item(["/farm"])).toBeUndefined();
  expect(item(["/farm", "/settings/profile"])?.to).toBe("/settings");
});

/* Settings is pinned, so it must not also appear as a row inside a group. */
test("keeps Settings out of the scrolling group list", () => {
  const sidebar = SIDEBAR_GROUPS.flatMap((group) => group.items).map((item) => item.to);

  expect(sidebar).not.toContain("/settings");
});

test("keeps business configuration out of the sidebar and inside Settings", () => {
  const sidebar = SIDEBAR_GROUPS.flatMap((group) => group.items).map((item) => item.to);
  const settings = SETTINGS_GROUPS.flatMap((group) => group.items).map((item) => item.to);

  for (const to of [
    "/business/models",
    "/business/secrets",
    "/business/soul",
    "/integrations",
    "/operations",
    "/business/observability",
  ]) {
    expect(sidebar).not.toContain(to);
    expect(settings).toContain(to);
  }
});

test("shows the design guide only to a developer", () => {
  const labelsFor = (isDev: boolean) =>
    visibleSettingsGroups({ isDev }).flatMap((group) => group.items.map((item) => item.label));

  expect(labelsFor(false)).not.toContain("Design guide");
  expect(labelsFor(true)).toContain("Design guide");
});

/* A shorter path must not swallow a longer sibling that shares its prefix. */
test("resolves a path to the most specific nav item that owns it", () => {
  expect(sectionForPath("/business/access/teams")?.label).toBe("People & access");
  expect(sectionForPath("/settings/profile")?.label).toBe("Profile");
  expect(sectionForPath("/knowledge/spaces/ops")?.label).toBe("Knowledge");
  expect(sectionForPath("/chat/c1")).toBeUndefined();
});
