import { ChevronRight, FileText, Folder } from "lucide-react";
import { useState } from "react";
import type { SoulTreeNode } from "~/lib/soul";
import { cn } from "~/lib/utils";

type Props = {
  root: SoulTreeNode[];
  selected: string | null;
  onSelect: (path: string) => void;
};

export function SoulTree({ root, selected, onSelect }: Props) {
  return (
    <ul className="flex flex-col gap-0.5 py-2 text-sm">
      {root.map((node) => (
        <Node key={node.path} node={node} depth={0} selected={selected} onSelect={onSelect} />
      ))}
    </ul>
  );
}

function Node({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: SoulTreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0); // top-level dirs open by default
  const pad = { paddingLeft: `${depth * 0.75 + 0.25}rem` };

  if (node.type === "dir") {
    const children = node.children ?? [];
    return (
      <li>
        <div className="group flex items-center gap-1 rounded-sm pr-1 hover:bg-accent" style={pad}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Collapse" : "Expand"}
            className="cursor-pointer rounded-sm p-0.5 text-muted-foreground"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
              aria-hidden
            />
          </button>
          <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="min-w-0 flex-1 cursor-pointer truncate py-1 text-left font-medium text-foreground"
            title={node.name}
          >
            {node.name}
          </button>
        </div>
        {open && children.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {children.map((child) => (
              <Node
                key={child.path}
                node={child}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  const isActive = selected === node.path;
  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-sm pr-1",
          isActive ? "bg-sidebar-accent" : "hover:bg-accent"
        )}
        style={pad}
      >
        <span className="w-[1.375rem] shrink-0" aria-hidden />
        <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          aria-current={isActive ? "true" : undefined}
          className={cn(
            "min-w-0 flex-1 cursor-pointer truncate py-1 text-left",
            isActive ? "font-medium text-sidebar-primary" : "text-foreground"
          )}
          title={node.name}
        >
          {node.name}
        </button>
      </div>
    </li>
  );
}
