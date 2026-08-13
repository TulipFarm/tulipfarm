import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityCatalog } from "~/lib/authz";
import { LevelBuilder } from "./level-builder";

const createLevel = vi.hoisted(() => vi.fn());

vi.mock("~/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/authz")>()),
  createLevel,
}));

const CATALOG: CapabilityCatalog = {
  areas: [
    {
      id: "github",
      label: "GitHub",
      capabilities: [
        {
          id: "github.issue.create",
          action: "github.issue.create",
          resourceTypes: ["integration.github"],
          label: "Add issue",
          changesThings: true,
          tools: ["github_issue_create"],
        },
        {
          id: "github.issue.list",
          action: "github.issue.list",
          resourceTypes: ["integration.github"],
          label: "See issue",
          changesThings: false,
          tools: ["github_issue_list"],
        },
      ],
    },
    {
      id: "record",
      label: "Records",
      capabilities: [
        {
          id: "record.read",
          action: "record.read",
          resourceTypes: ["record"],
          label: "See record",
          changesThings: false,
          tools: ["record_get"],
        },
      ],
    },
  ],
  unavailable: [
    {
      action: "soul.repo.push",
      resourceTypes: ["Tool"],
      tools: ["soul_repo_push"],
      reason: "resource_not_authorable",
    },
  ],
};

function open(catalog: CapabilityCatalog | null = CATALOG, onCreated = vi.fn()) {
  render(<LevelBuilder open onClose={vi.fn()} catalog={catalog} onCreated={onCreated} />);
  return { onCreated };
}

beforeEach(() => {
  createLevel.mockReset();
  createLevel.mockResolvedValue({ id: "x", slug: "kitchen-staff", displayName: "Kitchen staff" });
});

describe("what it offers", () => {
  it("names things in plain language, not action strings alone", () => {
    open();
    expect(screen.getByText("Add issue")).toBeInTheDocument();
    expect(screen.getByText("See record")).toBeInTheDocument();
  });

  /*
   * The point of the whole catalog: the owner sees which Tool a permission belongs to. Showing
   * only a level name is how the previous screen left them guessing.
   */
  it("groups capabilities under the product they belong to", () => {
    open();
    expect(screen.getByRole("heading", { name: "GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Records" })).toBeInTheDocument();
  });

  it("warns which capabilities change things rather than only look at them", () => {
    open();
    const addIssue = screen.getByLabelText("Add issue").closest("label");
    const seeIssue = screen.getByLabelText("See issue").closest("label");
    expect(within(addIssue as HTMLElement).getByText("Changes things")).toBeInTheDocument();
    expect(within(seeIssue as HTMLElement).queryByText("Changes things")).toBeNull();
  });

  /*
   * A picker that silently offers less than the system supports sends the owner hunting for a
   * permission the screen decided not to mention.
   */
  it("admits what cannot go in a level instead of hiding it", async () => {
    open();
    await userEvent.click(screen.getByText(/cannot be put in an access level/));
    expect(screen.getByText("soul.repo.push")).toBeInTheDocument();
  });

  it("says so when there is nothing to grant, rather than looking broken", () => {
    open({ areas: [], unavailable: [] });
    expect(screen.getByText(/Nothing can be granted yet/)).toBeInTheDocument();
  });

  it("says it is loading rather than claiming there is nothing", () => {
    open(null);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing can be granted yet/)).toBeNull();
  });
});

describe("picking", () => {
  it("finds a capability by what it is called", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Search what they can do"), "record");
    expect(screen.getByText("See record")).toBeInTheDocument();
    expect(screen.queryByText("Add issue")).toBeNull();
  });

  it("finds a capability by the Tool that needs it", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Search what they can do"), "github_issue_create");
    expect(screen.getByText("Add issue")).toBeInTheDocument();
    expect(screen.queryByText("See record")).toBeNull();
  });

  it("says when a search matches nothing", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Search what they can do"), "payroll");
    expect(screen.getByText(/Nothing matches "payroll"/)).toBeInTheDocument();
  });

  it("takes a whole area in one click", async () => {
    open();
    await userEvent.click(screen.getAllByRole("button", { name: "Pick all" })[0]);
    expect(screen.getByText("2 picked")).toBeInTheDocument();
  });

  /*
   * A filtered "pick all" that quietly selected hidden capabilities would grant things the owner
   * never saw. It applies to what is on screen, and the count proves it.
   */
  it("picks only what the search left on screen", async () => {
    open();
    // "Add issue" alone, so a "pick all" that ignored the filter would count 2, not 1.
    await userEvent.type(screen.getByLabelText("Search what they can do"), "Add issue");
    await userEvent.click(screen.getByRole("button", { name: "Pick all" }));
    expect(screen.getByText("1 picked")).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText("Search what they can do"));
    expect(screen.getByLabelText("See issue")).not.toBeChecked();
    expect(screen.getByLabelText("Add issue")).toBeChecked();
  });

  it("clears an area it has already picked", async () => {
    open();
    await userEvent.click(screen.getAllByRole("button", { name: "Pick all" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByText("Nothing picked yet")).toBeInTheDocument();
  });
});

describe("saving", () => {
  it("will not save without a name", async () => {
    open();
    await userEvent.click(screen.getByLabelText("See record"));
    expect(screen.getByRole("button", { name: /Create level/ })).toBeDisabled();
  });

  /*
   * A level that allows nothing looks saved and grants nothing — the exact silent failure this
   * whole surface exists to stop.
   */
  it("will not save a level that allows nothing", async () => {
    open();
    await userEvent.type(screen.getByLabelText(/^Name$/), "Kitchen staff");
    expect(screen.getByRole("button", { name: /Create level/ })).toBeDisabled();
  });

  it("sends the name and exactly the capabilities that were ticked", async () => {
    const { onCreated } = open();
    await userEvent.type(screen.getByLabelText(/^Name$/), "  Kitchen staff  ");
    await userEvent.click(screen.getByLabelText("See record"));
    await userEvent.click(screen.getByRole("button", { name: /Create level/ }));

    await waitFor(() => expect(createLevel).toHaveBeenCalledWith("Kitchen staff", ["record.read"]));
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("does not send a capability that was ticked and then unticked", async () => {
    open();
    await userEvent.type(screen.getByLabelText(/^Name$/), "Mixed");
    await userEvent.click(screen.getByLabelText("Add issue"));
    await userEvent.click(screen.getByLabelText("See record"));
    await userEvent.click(screen.getByLabelText("Add issue"));
    await userEvent.click(screen.getByRole("button", { name: /Create level/ }));

    await waitFor(() => expect(createLevel).toHaveBeenCalledWith("Mixed", ["record.read"]));
  });

  /*
   * The server names the capability it refused and why a name was rejected. Replacing that with a
   * generic apology throws away the only part the owner can act on.
   */
  it("shows the server's own reason for a refusal", async () => {
    createLevel.mockRejectedValueOnce(new Error('a level named "Kitchen staff" already exists'));
    open();
    await userEvent.type(screen.getByLabelText(/^Name$/), "Kitchen staff");
    await userEvent.click(screen.getByLabelText("See record"));
    await userEvent.click(screen.getByRole("button", { name: /Create level/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
  });

  it("leaves the picks in place after a failure so nothing is retyped", async () => {
    createLevel.mockRejectedValueOnce(new Error("nope"));
    open();
    await userEvent.type(screen.getByLabelText(/^Name$/), "Kitchen staff");
    await userEvent.click(screen.getByLabelText("See record"));
    await userEvent.click(screen.getByRole("button", { name: /Create level/ }));

    await screen.findByRole("alert");
    expect(screen.getByLabelText(/^Name$/)).toHaveValue("Kitchen staff");
    expect(screen.getByLabelText("See record")).toBeChecked();
  });
});
