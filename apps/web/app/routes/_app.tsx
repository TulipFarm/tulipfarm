import { Outlet, redirect, useLocation } from "@remix-run/react";
import { AppSidebar } from "~/components/app-sidebar";
import { ApiError, getSession } from "~/lib/api";
import { ApprovalsProvider } from "~/lib/approvals-context";
import { ConversationsProvider } from "~/lib/conversations-context";

// Auth gate for the whole app shell: every /app/* route runs this parent loader first. An
// unauthenticated session (401) redirects to /login (preserving where the user was headed); a dev
// Bearer token (VITE_API_TOKEN) authenticates too, so that path keeps working. Other errors bubble
// to the route ErrorBoundary.
export async function clientLoader() {
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
  // The Knowledge wiki provides its own page-tree rail, so the main nav auto-collapses to its icon
  // rail under /knowledge (transient — the persisted collapse preference is untouched).
  const onKnowledge = useLocation().pathname.startsWith("/knowledge");
  return (
    <ApprovalsProvider>
      <ConversationsProvider>
        {/* Desktop shell is capped to the viewport (h-svh + overflow-hidden) so the sidebar nav and
            the main panel each scroll internally instead of growing the whole page. */}
        <div className="md:flex md:h-svh md:overflow-hidden">
          <AppSidebar forceCollapsed={onKnowledge} />
          <main className="min-h-[calc(100svh-3rem)] flex-1 overflow-auto md:h-svh md:min-h-0">
            <Outlet />
          </main>
        </div>
      </ConversationsProvider>
    </ApprovalsProvider>
  );
}
