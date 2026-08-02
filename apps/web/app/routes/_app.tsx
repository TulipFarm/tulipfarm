import { Outlet, redirect } from "@remix-run/react";
import { AppShell } from "~/components/app-sidebar";
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
  return (
    <ApprovalsProvider>
      <ConversationsProvider>
        <AppShell>
          <a
            href="#main-content"
            className="fixed left-2 top-2 z-[100] -translate-y-16 bg-background px-3 py-2 text-sm focus:translate-y-0"
          >
            Skip to main content
          </a>
          <Outlet />
          <GlobalConnectionStatus />
        </AppShell>
      </ConversationsProvider>
    </ApprovalsProvider>
  );
}
