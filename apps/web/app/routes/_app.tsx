import { Outlet } from "@remix-run/react";
import { AppSidebar } from "~/components/app-sidebar";
import { ApprovalsProvider } from "~/lib/approvals-context";

// Persistent shell: sidebar + main panel. Wraps every section route. The ApprovalsProvider polls
// pending approvals once for the whole shell, feeding both the sidebar badge and the Approvals page.
export default function AppLayout() {
  return (
    <ApprovalsProvider>
      <div className="md:flex md:min-h-svh">
        <AppSidebar />
        <main className="min-h-[calc(100svh-3rem)] flex-1 overflow-auto md:min-h-svh">
          <Outlet />
        </main>
      </div>
    </ApprovalsProvider>
  );
}
