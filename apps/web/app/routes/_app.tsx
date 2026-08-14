import { Outlet, redirect, useLoaderData } from "@remix-run/react";
import { AppShell } from "~/components/app-sidebar";
import { OnboardingCompanion } from "~/components/onboarding/companion";
import { GlobalConnectionStatus } from "~/components/shell/states";
import { ApiError, getSession } from "~/lib/api";
import { ApprovalsProvider } from "~/lib/approvals-context";
import { CompanionProvider } from "~/lib/companion-context";
import { ConversationsProvider } from "~/lib/conversations-context";
import { getSetupStatus } from "~/lib/setup";

// Auth gate for the whole app shell: every /app/* route runs this parent loader first.
// Checks setup status first: if the instance needs first-run setup, redirect to /setup.
// Then checks auth: unauthenticated session (401) redirects to /login.
export async function clientLoader() {
  // Both requests go out together: this loader gates the first paint, so a second serial round trip
  // is pure blank-screen time on a slow host. Precedence is unchanged — setup still wins over auth.
  // On an un-set-up instance this does spend one wasted (401) session call, which is the cheaper
  // trade: that path redirects to /setup once, while the authed path is every single page load.
  const [setup, session] = await Promise.all([
    getSetupStatus(),
    getSession().then(
      (user) => ({ ok: true as const, user }),
      (err: unknown) => ({ ok: false as const, err })
    ),
  ]);

  if (setup.needsSetup) throw redirect("/setup");

  if (!session.ok) {
    if (session.err instanceof ApiError && session.err.status === 401) {
      const here = typeof window !== "undefined" ? window.location.pathname : "/";
      throw redirect(`/login?redirectTo=${encodeURIComponent(here)}`);
    }
    throw session.err;
  }

  return { user: session.user };
}

// Persistent shell: sidebar + main panel. Wraps every section route. ApprovalsProvider polls pending
// approvals (sidebar badge + Approvals page); ConversationsProvider holds the Recent chats list.
export default function AppLayout() {
  const { user } = useLoaderData<typeof clientLoader>();
  return (
    <ApprovalsProvider>
      <ConversationsProvider>
        <CompanionProvider>
          <AppShell isAdmin={user.role === "admin"} user={user}>
            <a
              href="#main-content"
              className="fixed left-2 top-2 z-[100] -translate-y-16 bg-background px-3 py-2 text-sm focus:translate-y-0"
            >
              Skip to main content
            </a>
            <Outlet />
            <GlobalConnectionStatus />
            <OnboardingCompanion />
          </AppShell>
        </CompanionProvider>
      </ConversationsProvider>
    </ApprovalsProvider>
  );
}
