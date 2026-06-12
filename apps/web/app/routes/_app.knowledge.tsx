import { type MetaFunction, NavLink, Outlet } from "@remix-run/react";

export const meta: MetaFunction = () => [{ title: "Knowledge · tulipfarm" }];

const TABS = [
  { to: "/knowledge/documents", label: "documents" },
  { to: "/knowledge/collections", label: "collections" },
];

/*
 * Layout for the Knowledge subtree: a bracket sub-nav (documents | collections) over the child
 * outlet. The active tab wears ruby brackets, matching the terminal `[section]` motif. Children own
 * their own data + panels; `_index` redirects to /knowledge/documents.
 */
export default function KnowledgeLayout() {
  return (
    <div className="flex flex-col">
      <nav className="mx-auto flex w-full max-w-4xl items-center gap-4 px-6 pt-8 text-xs uppercase tracking-[0.2em]">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className="transition-colors">
            {({ isActive }) => (
              <span
                className={
                  isActive ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }
              >
                {isActive ? "[ " : ""}
                {t.label}
                {isActive ? " ]" : ""}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
