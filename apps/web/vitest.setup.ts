import "@testing-library/jest-dom/vitest";

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

// jsdom does not implement ResizeObserver; <A2uiFrame> uses it to auto-size the iframe. The mock
// is inert (no layout in jsdom) — the resize round-trip is covered in a real browser (Playwright).
Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  value: class {
    observe = () => {};
    unobserve = () => {};
    disconnect = () => {};
  },
});
