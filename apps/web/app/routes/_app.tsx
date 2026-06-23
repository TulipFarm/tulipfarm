import { Outlet, redirect } from "@remix-run/react";
import { AppSidebar } from "~/components/app-sidebar";
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
  return (
    <ApprovalsProvider>
      <ConversationsProvider>
        {/* Desktop shell is capped to the viewport (h-svh + overflow-hidden) so the sidebar nav and
            the main panel each scroll internally instead of growing the whole page. */}
        <div className="md:flex md:h-svh md:overflow-hidden">
          <AppSidebar />
          <main className="min-h-[calc(100svh-3rem)] flex-1 overflow-auto md:h-svh md:min-h-0">
            <Outlet />
          </main>
        </div>
      </ConversationsProvider>
    </ApprovalsProvider>
  );
}
