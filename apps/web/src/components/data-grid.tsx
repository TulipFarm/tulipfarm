/** Hand-assembled table parts for the records grid, which needs page-scoped selection, disabled sorting and fixed loading rows that sprout's config-driven Table does not offer yet. */
import * as React from 'react';
import { cn } from 'cn';
import { ArrowDown } from 'reicon-react/icons/ArrowDown';
import { ArrowUp } from 'reicon-react/icons/ArrowUp';
import { ArrowUpDown } from 'lucide-react';
import { Button } from '@tulipfarm/sprout/button';
import { ScrollArea } from '@tulipfarm/sprout/scroll-area';

function Table({
  className,
  variant = 'plain',
  ...props
}: React.ComponentProps<'table'> & { variant?: 'plain' | 'grid' }) {
  const table = (
    <table
      data-slot="table"
      className={cn(
        'w-full caption-bottom text-sm',
        variant === 'grid' &&
          '[&_tr]:border-input [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-muted [&_th]:border-r [&_th]:border-input [&_th]:px-3 [&_th:last-child]:border-r-0 [&_td]:border-r [&_td]:border-input [&_td]:px-3 [&_td]:py-2.5 [&_td:last-child]:border-r-0',
        className,
      )}
      {...props}
    />
  );
  return variant === 'grid' ? (
    <ScrollArea variant="table" orientation="both" viewportLabel={props['aria-label']} data-slot="table-container">
      {table}
    </ScrollArea>
  ) : (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      {table}
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

function TableRow({
  className,
  interactive = false,
  ...props
}: React.ComponentProps<'tr'> & { interactive?: boolean }) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-primary-subtle data-[state=selected]:[&>td:first-child]:relative data-[state=selected]:[&>td:first-child]:before:absolute data-[state=selected]:[&>td:first-child]:before:inset-y-0 data-[state=selected]:[&>td:first-child]:before:start-0 data-[state=selected]:[&>td:first-child]:before:w-1 data-[state=selected]:[&>td:first-child]:before:bg-primary',
        '[--table-row-bg:var(--card)] hover:[--table-row-bg:color-mix(in_srgb,var(--muted)_50%,var(--card))] has-aria-expanded:[--table-row-bg:color-mix(in_srgb,var(--muted)_50%,var(--card))] data-[state=selected]:[--table-row-bg:var(--muted)]',
        interactive && 'cursor-pointer',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({
  className,
  align = 'left',
  selection = false,
  stickyEnd = false,
  ...props
}: React.ComponentProps<'th'> & { align?: 'left' | 'right'; selection?: boolean; stickyEnd?: boolean }) {
  return (
    <th
      data-slot="table-head"
      data-sticky-end={stickyEnd || undefined}
      className={cn(
        'h-10 px-2 align-middle font-medium whitespace-nowrap text-foreground',
        align === 'right' ? 'text-right' : 'text-left',
        selection && 'w-12 min-w-12',
        stickyEnd &&
          'sticky right-0 z-20 w-px bg-muted before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-input',
        className,
      )}
      {...props}
    />
  );
}

function TableSortHead({
  sorted,
  onSort,
  align = 'left',
  clearsOnDescending = false,
  disabled,
  children,
}: {
  sorted: 'asc' | 'desc' | false;
  onSort: () => void;
  align?: 'left' | 'right';
  clearsOnDescending?: boolean;
  disabled?: boolean;
  children: string;
}) {
  const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown;
  const hint =
    sorted === 'asc'
      ? ', ascending. Select for descending'
      : sorted === 'desc'
        ? `, descending. ${clearsOnDescending ? 'Select to clear' : 'Select for ascending'}`
        : '';
  return (
    <TableHead align={align} aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}>
      <Button
        variant={sorted ? 'secondary' : 'ghost'}
        size={align === 'right' ? 'column-header-end' : 'column-header'}
        aria-label={`Sort by ${children}${hint}`}
        title={sorted ? undefined : 'Sort ascending'}
        disabled={disabled}
        onClick={onSort}
      >
        {children}
        <Icon size={14} aria-hidden="true" />
      </Button>
    </TableHead>
  );
}

function TableCell({
  className,
  align = 'left',
  selection = false,
  stickyEnd = false,
  ...props
}: React.ComponentProps<'td'> & { align?: 'left' | 'right'; selection?: boolean; stickyEnd?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      data-sticky-end={stickyEnd || undefined}
      className={cn(
        'p-2 align-middle whitespace-nowrap',
        align === 'right' && 'text-right tabular-nums',
        selection && 'w-12 min-w-12',
        stickyEnd &&
          'sticky right-0 z-1 w-px bg-(--table-row-bg) transition-colors before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-input',
        className,
      )}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableHead, TableSortHead, TableRow, TableCell };
