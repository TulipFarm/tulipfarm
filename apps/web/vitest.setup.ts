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
