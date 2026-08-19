import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearTreeExpansion, useTreeExpansion } from "./use-tree-expansion";

/**
 * A tree that forgets what was open the moment you read a Page is a tree you re-navigate on every
 * hop. Expansion is therefore session state, not component state — it must outlive the unmount that
 * happens when the sidebar re-renders for a new route.
 */
describe("useTreeExpansion", () => {
  beforeEach(() => {
    clearTreeExpansion();
  });

  it("starts closed for a branch nobody has opened", () => {
    const { result } = renderHook(() => useTreeExpansion("space-1", "notes"));
    expect(result.current.open).toBe(false);
  });

  it("remembers a branch opened before the component unmounted", () => {
    const first = renderHook(() => useTreeExpansion("space-1", "notes"));
    act(() => first.result.current.toggle());
    first.unmount();

    const second = renderHook(() => useTreeExpansion("space-1", "notes"));
    expect(second.result.current.open).toBe(true);
  });

  it("remembers a branch closed again", () => {
    const first = renderHook(() => useTreeExpansion("space-1", "notes"));
    act(() => first.result.current.toggle());
    act(() => first.result.current.toggle());
    first.unmount();

    const second = renderHook(() => useTreeExpansion("space-1", "notes"));
    expect(second.result.current.open).toBe(false);
  });

  it("keeps branches of different Spaces apart", () => {
    const a = renderHook(() => useTreeExpansion("space-1", "notes"));
    act(() => a.result.current.toggle());

    const b = renderHook(() => useTreeExpansion("space-2", "notes"));
    expect(b.result.current.open).toBe(false);
  });

  it("opens a branch on the path to the active Page without recording it as a user choice", () => {
    const { result, unmount } = renderHook(() =>
      useTreeExpansion("space-1", "notes", { forceOpen: true })
    );
    expect(result.current.open).toBe(true);
    unmount();

    // Navigating elsewhere must not leave the branch pinned open: it was open because the reader
    // was inside it, not because they asked for it.
    const after = renderHook(() => useTreeExpansion("space-1", "notes"));
    expect(after.result.current.open).toBe(false);
  });

  it("lets an explicit close win over being on the active path", () => {
    const { result } = renderHook(() => useTreeExpansion("space-1", "notes", { forceOpen: true }));
    act(() => result.current.toggle());
    expect(result.current.open).toBe(false);
  });

  it("survives a storage backend that refuses to write", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const { result } = renderHook(() => useTreeExpansion("space-1", "notes", { store: broken }));
    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);
  });
});
