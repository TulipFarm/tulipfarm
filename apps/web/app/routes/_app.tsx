import { Outlet, redirect, useLocation } from "@remix-run/react";
import { AppSidebar } from "~/components/app-sidebar";
import { GlobalConnectionStatus } from "~/components/shell/states";
import { ApiError, getSession } from "~/lib/api";
import { ApprovalsProvider } from "~/lib/approvals-context";
import { ConversationsProvider } from "~/lib/conversations-context";
import { getSetupStatus } from "~/lib/setup";

// Auth gate for the whole app shell: every /app/* route runs this parent loader first.
// Checks setup status first: if the instance needs first-run setup, redirect to /setup.
// Then checks auth: unauthenticated session (401) redirects to /login.
export async function clientLoader() {
  const { needsSetup } = await getSetupStatus();
  if (needsSetup) throw redirect("/setup");

  try {
    return { user: await getSession() };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      const here = typeof window !== "undefined" ? window.location.pathname : "/";
      throw redirect(`/login?redirectTo=${encodeURIComponent(here)}`);
    }
    throw err;
  }
}

// Persistent shell: sidebar + main panel. Wraps every section route. ApprovalsProvider polls pending
// approvals (sidebar badge + Approvals page); ConversationsProvider holds the Recent chats list.
export default function AppLayout() {
  // Knowledge and Settings each provide their own section rail, so the main nav auto-collapses to
  // its icon rail under those paths (transient — the persisted collapse preference is untouched).
  const { pathname } = useLocation();
  const collapseRail = pathname.startsWith("/knowledge") || pathname.startsWith("/settings");
  return (
    <ApprovalsProvider>
      <ConversationsProvider>
        {/* Desktop shell is capped to the viewport (h-svh + overflow-hidden) so the sidebar nav and
            the main panel each scroll internally instead of growing the whole page. */}
        <div className="md:flex md:h-svh md:overflow-hidden">
          <a
            href="#main-content"
            className="fixed left-2 top-2 z-[100] -translate-y-16 bg-background px-3 py-2 text-sm focus:translate-y-0"
          >
            Skip to main content
          </a>
          <AppSidebar forceCollapsed={collapseRail} />
          <main
            id="main-content"
            tabIndex={-1}
            className="min-h-[calc(100svh-3rem)] flex-1 overflow-auto md:h-svh md:min-h-0"
          >
            <Outlet />
          </main>
          <GlobalConnectionStatus />
        </div>
      </ConversationsProvider>
    </ApprovalsProvider>
  );
}
