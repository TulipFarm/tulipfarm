/**
 * The dialog's job is to stop a person misjudging who can read their work.
 *
 * Two failure modes drive these tests. A person who thinks they are *adding* a rule to an open
 * Page will pick one name and believe everyone else kept their access — so the dialog has to say
 * that restricting replaces Business-wide access, not qualify it. And a person whose Page inherits
 * an ancestor's restriction cannot loosen it here — so the dialog must show that as inherited and
 * name the ancestor, rather than presenting an editable list they will "fix" and lose.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PageVisibility, SubjectDirectory } from "~/lib/knowledge-api";
import { RestrictDialog } from "./restrict-dialog";

const directory: SubjectDirectory = {
  users: [
    { kind: "user", id: "u1", label: "Ana Ruiz" },
    { kind: "user", id: "u2", label: "Bo Lang" },
  ],
  teams: [{ kind: "group", id: "finance", label: "finance" }],
  roles: [{ kind: "role", id: "editor", label: "editor" }],
};

const open: PageVisibility = {
  restricted: false,
  scope: "business",
  own: [],
  inheritedFrom: null,
  readers: [],
};

const restricted: PageVisibility = {
  restricted: true,
  scope: "own",
  own: [{ kind: "user", id: "u1", label: "Ana Ruiz" }],
  inheritedFrom: null,
  readers: [{ kind: "user", id: "u1", label: "Ana Ruiz", via: null }],
};

const inherited: PageVisibility = {
  restricted: true,
  scope: "inherited",
  own: [],
  inheritedFrom: { pageId: "p0", path: "comp", title: "Compensation" },
  readers: [{ kind: "user", id: "u1", label: "Ana Ruiz", via: null }],
};

function setup(
  visibility: PageVisibility,
  overrides: Partial<Parameters<typeof RestrictDialog>[0]> = {}
) {
  const onRestrict = vi.fn().mockResolvedValue(undefined);
  const onClear = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <RestrictDialog
      open
      subjectLabel="Bands"
      visibility={visibility}
      directory={directory}
      onRestrict={onRestrict}
      onClear={onClear}
      onClose={onClose}
      {...overrides}
    />
  );
  return { onRestrict, onClear, onClose };
}

describe("choosing who can read this", () => {
  it("says that restricting replaces Business-wide access rather than adding exceptions", () => {
    setup(open);
    const note = screen.getByTestId("replace-note").textContent ?? "";
    expect(note).toMatch(/replaces/i);
    expect(note).toMatch(/everyone|business/i);
    expect(screen.queryByText(/in addition to/i)).toBeNull();
  });

  it("sends exactly the subjects that were picked", async () => {
    const { onRestrict } = setup(open);

    fireEvent.click(screen.getByRole("checkbox", { name: /Ana Ruiz/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /finance/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Restrict/ }));

    await waitFor(() => expect(onRestrict).toHaveBeenCalledTimes(1));
    expect(onRestrict.mock.calls[0][0]).toEqual([
      { kind: "user", id: "u1" },
      { kind: "group", id: "finance" },
    ]);
  });

  it("refuses to save an empty allowlist, which would lock everyone out", () => {
    const { onRestrict } = setup(open);
    fireEvent.click(screen.getByRole("button", { name: /^Restrict/ }));
    expect(onRestrict).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/at least one/i);
  });

  it("starts from the Page's current allowlist when it already carries one", () => {
    setup(restricted);
    expect((screen.getByRole("checkbox", { name: /Ana Ruiz/ }) as HTMLInputElement).checked).toBe(
      true
    );
    expect((screen.getByRole("checkbox", { name: /Bo Lang/ }) as HTMLInputElement).checked).toBe(
      false
    );
  });

  it("offers to return a restricted Page to the whole Business", async () => {
    const { onClear } = setup(restricted);
    fireEvent.click(screen.getByRole("button", { name: /whole business/i }));
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
  });

  it("does not offer that on an open Page, where there is nothing to clear", () => {
    setup(open);
    expect(screen.queryByRole("button", { name: /whole business/i })).toBeNull();
  });

  it("shows an inherited restriction as inherited, naming the ancestor it comes from", () => {
    setup(inherited);
    const note = screen.getByTestId("inherited-note");
    expect(note.textContent).toMatch(/Compensation/);
    expect(note.textContent).toMatch(/inherit/i);
  });

  it("reports a refusal from the server and keeps the picked names for correction", async () => {
    const onRestrict = vi
      .fn()
      .mockRejectedValue(new Error("comp allows only Ana Ruiz; Bo Lang is not permitted"));
    setup(open, { onRestrict });

    fireEvent.click(screen.getByRole("checkbox", { name: /Bo Lang/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Restrict/ }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/not permitted/));
    // The intended grant was refused whole; the person must still see what they had chosen.
    expect((screen.getByRole("checkbox", { name: /Bo Lang/ }) as HTMLInputElement).checked).toBe(
      true
    );
  });

  it("does not close itself when the save was refused", async () => {
    const onRestrict = vi.fn().mockRejectedValue(new Error("refused"));
    const { onClose } = setup(open, { onRestrict });

    fireEvent.click(screen.getByRole("checkbox", { name: /Ana Ruiz/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Restrict/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes once the save succeeds", async () => {
    const { onClose } = setup(open);
    fireEvent.click(screen.getByRole("checkbox", { name: /Ana Ruiz/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Restrict/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("will not fire twice while a save is in flight", async () => {
    let release: () => void = () => {};
    const onRestrict = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    setup(open, { onRestrict });

    fireEvent.click(screen.getByRole("checkbox", { name: /Ana Ruiz/ }));
    const save = screen.getByRole("button", { name: /^Restrict/ });
    fireEvent.click(save);
    fireEvent.click(save);

    expect(onRestrict).toHaveBeenCalledTimes(1);
    release();
  });

  it("names who can read it today, and how each of them got there", () => {
    setup({
      ...restricted,
      readers: [
        { kind: "user", id: "u1", label: "Ana Ruiz", via: null },
        { kind: "user", id: "u2", label: "Bo Lang", via: { kind: "group", id: "finance" } },
      ],
    });
    const who = screen.getByTestId("who-can-see");
    expect(who.textContent).toMatch(/Ana Ruiz/);
    expect(who.textContent).toMatch(/Bo Lang/);
    expect(who.textContent).toMatch(/finance/);
  });
});
