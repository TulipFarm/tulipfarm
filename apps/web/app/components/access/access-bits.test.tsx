import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import type { AuthzGrant } from "~/lib/authz";
import { CapabilityList, RoleCard } from "./access-bits";

function grant(overrides: Partial<AuthzGrant> = {}): AuthzGrant {
  const effect = overrides.effect ?? "allow";
  const action = overrides.action ?? "*";
  const resourceType = overrides.resourceType ?? "*";
  return {
    effect,
    action,
    resourceType,
    label: overrides.label ?? `${effect} ${action} on ${resourceType}`,
    ...overrides,
  } as AuthzGrant;
}

function allowedLines(): string[] {
  const lists = screen.getAllByRole("list");
  return within(lists[0])
    .getAllByRole("listitem")
    .map((li) => li.textContent ?? "");
}

test("says so plainly when somebody has nothing", () => {
  render(<CapabilityList grants={[]} />);
  expect(screen.getByText("Nothing yet.")).toBeInTheDocument();
});

/*
 * The `member` Role is an unrestricted allow minus a list of denies. Rendering each derived allow
 * gave "Add to everything", "Change everything", "Remove from everything", "View everything" —
 * four lines that teach nothing and bury the denies, which are the only real information.
 */
test("an unrestricted allow is said once, not once per derived verb", () => {
  render(
    <CapabilityList
      grants={[
        grant({ action: "*", resourceType: "*" }),
        grant({
          action: "*",
          resourceType: "*",
          label: "allow any action on any resource in any domain",
        }),
        grant({ effect: "deny", action: "*", resourceType: "audit" }),
      ]}
    />
  );

  expect(
    screen.getByText(/Everything in the business, apart from what is listed below/)
  ).toBeInTheDocument();
  expect(screen.queryByText("Do anything")).not.toBeInTheDocument();
  expect(screen.getByText("Manage owner tools")).toBeInTheDocument();
});

test("drops the caveat when an unrestricted allow really is unrestricted", () => {
  render(<CapabilityList grants={[grant({ action: "*", resourceType: "*" })]} />);
  expect(screen.getByText("Everything in the business.")).toBeInTheDocument();
});

/*
 * Distinct resource types in the same family collapse to one area name, so an allow on `authz.role`
 * and a deny on `authz` produced the identical phrase in both lists. Shown twice it is a flat
 * contradiction; the reader has no way to tell which one wins.
 */
test("a phrase that is both allowed and blocked is shown once, as partial", () => {
  render(
    <CapabilityList
      grants={[
        grant({ action: "*", resourceType: "authz.role" }),
        grant({ effect: "deny", action: "*", resourceType: "authz" }),
      ]}
    />
  );

  expect(screen.getAllByText("Manage people and access")).toHaveLength(1);
  expect(screen.getByText("Only some of these")).toBeInTheDocument();
  expect(screen.queryByText("Explicitly blocked")).not.toBeInTheDocument();
});

test("keeps a clean allow and a clean deny in their own groups", () => {
  render(
    <CapabilityList
      grants={[
        grant({ action: "record.read", resourceType: "record.customer" }),
        grant({ effect: "deny", action: "*", resourceType: "audit" }),
      ]}
    />
  );

  expect(allowedLines()).toEqual(["View Customer records"]);
  expect(screen.getByText("Explicitly blocked")).toBeInTheDocument();
  expect(screen.getByText("Manage owner tools")).toBeInTheDocument();
  expect(screen.queryByText("Only some of these")).not.toBeInTheDocument();
});

/*
 * Two grants differing only in a dimension this view drops (a domain, a condition) render the same
 * sentence. Printing it twice reads as a rendering bug.
 */
test("does not repeat a sentence two grants happen to share", () => {
  render(
    <CapabilityList
      grants={[
        grant({ action: "record.read", resourceType: "record.customer" }),
        grant({
          action: "record.read",
          resourceType: "record.customer",
          label: "allow record.read on record.customer in eu",
        }),
      ]}
    />
  );

  expect(allowedLines()).toEqual(["View Customer records"]);
});

/*
 * The card says the Role's own words and nothing derived on top of them. `member`'s allow-only
 * area list named "people and access" directly under a blurb saying it cannot manage them, and a
 * Role without copy got the same sentence printed twice. Both were the same extra line.
 */
test("says a Role's own words once, with nothing derived under them", () => {
  render(
    <RoleCard
      summary={{
        title: "Support operators",
        blurb: "Covers records.",
        areas: [{ id: "records", label: "Records", blurb: "Customers, orders and tickets." }],
        unrestricted: false,
      }}
    />
  );

  expect(screen.getAllByText("Covers records.")).toHaveLength(1);
});

test("does not contradict a Role's blurb with the areas its allows touch", () => {
  render(
    <RoleCard
      summary={{
        title: "Everyday access",
        blurb: "Day-to-day work. Cannot manage people or settings.",
        areas: [
          { id: "access", label: "People and access", blurb: "Who can do what." },
          { id: "records", label: "Records", blurb: "Customers, orders and tickets." },
        ],
        unrestricted: false,
      }}
    />
  );

  expect(
    screen.getByText("Day-to-day work. Cannot manage people or settings.")
  ).toBeInTheDocument();
  expect(screen.queryByText(/^Covers /)).not.toBeInTheDocument();
});
