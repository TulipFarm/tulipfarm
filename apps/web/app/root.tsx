import {
  Links,
  Meta,
  type MetaFunction,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";
import "@fontsource-variable/jetbrains-mono";
import { type ReactNode, useEffect } from "react";
import "~/app.css";

// Default document title + description; per-route meta overrides the title.
export const meta: MetaFunction = () => [
  { title: "tulipfarm" },
  { name: "description", content: "The business agent harness." },
];

/*
 * Runs before hydration: reads the persisted theme (or system preference) and sets
 * [data-theme] on <html> so there is no flash of the wrong palette. AC-V1-005.
 */
const themeInit = `(function(){try{var t=localStorage.getItem("theme");if(!t){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

function Document({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the pre-hydration themeInit script sets [data-theme] on <html>
    // before React hydrates, which would otherwise log a hydration mismatch and be stripped.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: no-flash theme init must run pre-hydration */}
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  // Re-assert the persisted theme after hydration: in SPA mode React reconciles <html> and can drop
  // the [data-theme] the pre-hydration script set, silently reverting dark mode on reload. AC-V1-005.
  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const theme =
      stored === "dark" || stored === "light"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.documentElement.setAttribute("data-theme", theme);
  }, []);

  return (
    <Document>
      <Outlet />
    </Document>
  );
}

// Required in Remix SPA mode: rendered into build/client/index.html at build time.
export function HydrateFallback() {
  return (
    <Document>
      <div />
    </Document>
  );
}
