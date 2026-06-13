import { Outlet } from "@remix-run/react";
import { AppSidebar } from "~/components/app-sidebar";
import { ApprovalsProvider } from "~/lib/approvals-context";
import { ConversationsProvider } from "~/lib/conversations-context";

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
