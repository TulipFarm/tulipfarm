import {
  type HtmlLinkDescriptor,
  Links,
  Meta,
  type MetaFunction,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";
import { NuqsAdapter } from "nuqs/adapters/remix";
import { type ReactNode, useEffect } from "react";
import { readThemePreference, resolveTheme } from "~/lib/theme";
import "~/app.css";

// Default document title + description; per-route meta overrides the title.
export const meta: MetaFunction = () => [
  { title: "tulipfarm" },
  { name: "description", content: "The business agent harness." },
  { name: "theme-color", content: "#E11D63" },
];

// Favicon + PWA install metadata. Assets live in apps/web/public and are copied verbatim
// into the build output, served as real files by the API's static handler (wildcard: false).
export const links = (): HtmlLinkDescriptor[] => [
  { rel: "icon", href: "/favicon.ico", sizes: "any" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/manifest.webmanifest" },
];

/*
 * Runs before hydration: resolves the stored preference ("system" or absent means follow the OS)
 * and sets [data-theme] on <html> so there is no flash of the wrong palette. It also mirrors the
 * persisted sidebar width onto [data-sidebar], which both the HydrateFallback skeleton (baked into
 * index.html, painted before any JS runs) and AppShell's initial state read — so the shell never
 * snaps from expanded to collapsed on load.
 */
const themeInit = `(function(){try{var p=localStorage.getItem("theme");var t=(p==="light"||p==="dark")?p:(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);document.documentElement.setAttribute("data-sidebar",localStorage.getItem("sidebar-collapsed")==="true"?"collapsed":"expanded");}catch(e){}})();`;

function Document({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the pre-hydration themeInit script sets [data-theme] on <html>
    // before React hydrates, which would otherwise log a hydration mismatch and be stripped.
    <html lang="en" className="h-full overflow-hidden" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: no-flash theme init must run pre-hydration */}
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="h-full overflow-hidden">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  // Re-assert the persisted theme after hydration: in SPA mode React reconciles <html> and can drop
  // the [data-theme] the pre-hydration script set, silently reverting dark mode on reload.
  useEffect(() => {
    const apply = () =>
      document.documentElement.setAttribute("data-theme", resolveTheme(readThemePreference()));
    apply();

    // Someone on "system" who flips their OS appearance expects the app to follow without a reload.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (readThemePreference() === "system") apply();
    };
    media.addEventListener("change", onSystemChange);
    return () => media.removeEventListener("change", onSystemChange);
  }, []);

  return (
    <Document>
      {/* NuqsAdapter wires type-safe URL search-param state (useQueryState) to the Remix router. */}
      <NuqsAdapter>
        <Outlet />
      </NuqsAdapter>
    </Document>
  );
}

/*
 * Required in Remix SPA mode: rendered into build/client/index.html at build time, so this markup is
 * the very first thing the browser can paint — before a single byte of route JS is parsed, and long
 * before the shell's clientLoader resolves. It must therefore stay static: no hooks, no data, no
 * imports beyond the document shell. It mirrors AppShell's frame (sidebar + 52px header + main) so
 * the real UI fills into the same boxes instead of replacing a blank page.
 */
export function HydrateFallback() {
  return (
    <Document>
      <div className="flex h-svh overflow-hidden bg-background">
        <div className="hidden w-[var(--shell-sidebar-width)] shrink-0 border-sidebar-border border-r bg-sidebar lg:block">
          <div className="flex h-[52px] items-center gap-2 overflow-hidden border-sidebar-border border-b px-4">
            <span className="size-6 shrink-0 rounded-md bg-muted" />
            <span className="h-3.5 w-20 rounded-sm bg-muted" />
          </div>
        </div>
        <div className="flex h-svh min-w-0 flex-1 flex-col">
          <div className="flex h-[52px] shrink-0 items-center gap-2 border-border border-b px-3 sm:px-4">
            <span className="size-9 rounded-md bg-muted" />
            <span className="h-4 w-32 rounded-sm bg-muted" />
            <span className="ml-auto size-8 rounded-full bg-muted" />
          </div>
          <div className="min-h-0 flex-1" />
        </div>
      </div>
    </Document>
  );
}
