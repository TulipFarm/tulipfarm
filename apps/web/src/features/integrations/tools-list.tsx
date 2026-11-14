import { useState, type ReactNode } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@tulipfarm/sprout/button';

export type ToolRowView = {
  key: string;
  title: string;
  description: string;
  off?: boolean;
  badges?: ReactNode;
  /** A switch before the title, for tools people can turn on and off. */
  control?: ReactNode;
  /** A setting after the description, such as whether the tool asks first. */
  setting?: ReactNode;
  details?: ReactNode;
};

const shown = 5;

/** One group of tools, such as "Reads data". Long groups show five tools and a button for the rest. */
export function ToolGroup({
  id,
  title,
  note,
  rows,
  expanded = false,
}: {
  id: string;
  title: string;
  note: string;
  rows: ToolRowView[];
  /** Show every row, as while searching. */
  expanded?: boolean;
}) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return null;
  const visible = all || expanded ? rows : rows.slice(0, shown);
  return (
    <section aria-labelledby={`tools-${id}`} className="space-y-2">
      <h3 id={`tools-${id}`} className="text-sm font-medium text-foreground">
        {title} <span className="font-normal text-muted-foreground">· {note}</span>
      </h3>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {visible.map(row => (
          <li key={row.key} className={row.off ? 'bg-muted/40' : undefined}>
            <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
              {row.control}
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={row.off ? 'font-medium text-muted-foreground' : 'font-medium text-foreground'}>
                    {row.title}
                  </span>
                  {row.badges}
                </p>
                {row.description && (
                  <p className="truncate text-sm text-muted-foreground" title={row.description}>
                    {row.description}
                  </p>
                )}
              </div>
              {row.setting}
              {row.details && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-expanded={open === row.key}
                  aria-label={`${open === row.key ? 'Hide' : 'Show'} details for ${row.title}`}
                  onClick={() => setOpen(open === row.key ? null : row.key)}
                >
                  {open === row.key ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
                </Button>
              )}
            </div>
            {open === row.key && row.details && <div className="px-4 pb-3 sm:ps-16">{row.details}</div>}
          </li>
        ))}
        {visible.length < rows.length && (
          <li className="px-2 py-1.5">
            <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
              Show {rows.length - visible.length} more
            </Button>
          </li>
        )}
      </ul>
    </section>
  );
}
