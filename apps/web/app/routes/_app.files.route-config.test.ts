import path from "node:path";
import { flatRoutes } from "@remix-run/dev/dist/config/flat-routes.js";
import { describe, expect, it } from "vitest";

const APP_DIRECTORY = path.resolve(import.meta.dirname, "..");

/**
 * `_app.files.$fileId.tsx` used to sit directly under the library layout route
 * (`_app.files.tsx`), which renders its own full-page UI with no `<Outlet />`. Remix nests any
 * `_app.files.*` route beneath it, so the detail route's element was built but never mounted —
 * the library kept rendering underneath the unchanged URL. Escaping the nesting with a trailing
 * underscore (`_app.files_.$fileId.tsx`) makes the detail route a sibling of the library instead
 * of its child, so it renders on its own. This test reads the real flat-routes config Remix would
 * generate for `apps/web/app/routes`, so it fails again if a future rename reintroduces nesting.
 */
describe("files route config", () => {
  it("renders the File detail route as a sibling of the library, not nested under it", () => {
    const routes = flatRoutes(APP_DIRECTORY, ["**/.*", "**/*.test.{ts,tsx}"]);

    const library = routes["routes/_app.files"];
    const detail = routes["routes/_app.files_.$fileId"];

    expect(library).toBeDefined();
    expect(detail).toBeDefined();
    expect(detail?.parentId).not.toBe(library?.id);
    expect(detail?.path).toBe("files/:fileId");
  });
});
