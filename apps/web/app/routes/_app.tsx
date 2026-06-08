import { Outlet } from "@remix-run/react";
import { AppSidebar } from "~/components/app-sidebar";

// Persistent shell: sidebar + main panel. Wraps every section route.
export default function AppLayout() {
  return (
    <div className="md:flex md:min-h-svh">
      <AppSidebar />
      <main className="min-h-[calc(100svh-3rem)] flex-1 overflow-auto md:min-h-svh">
        <Outlet />
      </main>
    </div>
  );
}
