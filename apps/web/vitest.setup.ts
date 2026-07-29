import "@testing-library/jest-dom/vitest";

// vitest 4.x jsdom: --localstorage-file path can be invalid, leaving localStorage without clear().
// Override with a reliable in-memory implementation for all tests.
const makeStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
};
Object.defineProperty(window, "localStorage", { writable: true, value: makeStorage() });
Object.defineProperty(window, "sessionStorage", { writable: true, value: makeStorage() });

// jsdom does not implement matchMedia; the sidebar reads it for the desktop/mobile breakpoint.
// Report desktop (matches: true) so component tests exercise the full, visible nav.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

// jsdom does not implement ResizeObserver; the inert mock keeps layout-using components testable.
Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  value: class {
    observe = () => {};
    unobserve = () => {};
    disconnect = () => {};
  },
});

// jsdom does not implement elementFromPoint; ProseMirror's posAtCoords (reached by Tiptap's
// Placeholder viewport tracking when the rich-text composer mounts) calls it. Return null — callers
// treat "no element at point" as a no-op. The editor's interactive behavior is covered in Playwright.
if (!document.elementFromPoint) {
  document.elementFromPoint = () => null;
}
