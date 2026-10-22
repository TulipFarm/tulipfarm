import * as React from 'react';
import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import { InfoCircle } from 'reicon-react/icons/InfoCircle';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@tulipfarm/sprout/tooltip';

/** A heading with a `hint` shows an info icon whose tooltip explains the column. */
type DataListHeading = string | { label: string; hint: string };

const dataListVariants = cva('w-full text-sm', {
  variants: {
    columns: {
      two: '[--data-list-columns:minmax(0,1fr)_minmax(0,12rem)]',
      three: '[--data-list-columns:minmax(0,2fr)_minmax(0,3fr)_minmax(0,10rem)]',
      trailing: '[--data-list-columns:minmax(0,1fr)_minmax(0,0.45fr)_6rem_4rem_5rem]',
      four: '[--data-list-columns:minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,16rem)]',
      trailingActions: '[--data-list-columns:minmax(0,1fr)_minmax(0,8rem)_4.5rem_12rem]',
      chats: [
        '[--data-list-columns:minmax(0,1fr)_3.5rem]',
        '[&_[data-slot=data-list-row]]:focus-within:bg-muted/50',
        '[&_[data-slot=data-list-link]]:cursor-pointer [&_[data-slot=data-list-link]]:hover:underline [&_[data-slot=data-list-link]]:underline-offset-4',
        '[&_[data-slot=data-list-header]>:last-child]:text-right',
        '[&_[data-slot=data-list-row]]:list-stacked:grid-cols-[minmax(0,1fr)_auto]',
        '[&_[data-slot=data-list-actions]]:self-center',
      ].join(' '),
      settings: '[--data-list-columns:minmax(0,1fr)_7rem_minmax(0,14rem)_4rem]',
    },
    /** `container` shows columns once the list itself is 36rem wide, for column sets that crowd the name beside a sidebar. */
    stack: { viewport: '', container: '@container/data-list' },
  },
  defaultVariants: { columns: 'two', stack: 'viewport' },
});

function DataList({
  className,
  columns,
  stack,
  headings,
  children,
  ...props
}: Omit<React.ComponentProps<'div'>, 'role'> &
  VariantProps<typeof dataListVariants> & { headings: DataListHeading[] }) {
  return (
    <div
      role="table"
      data-slot="data-list"
      data-stack={stack ?? 'viewport'}
      className={cn(dataListVariants({ columns, stack, className }))}
      {...props}
    >
      <div
        role="row"
        data-slot="data-list-header"
        className="hidden border-b px-2 py-2 text-xs font-medium text-muted-foreground list-wide:grid list-wide:grid-cols-(--data-list-columns) list-wide:gap-4"
      >
        <TooltipProvider>
          {headings.map(heading =>
            typeof heading === 'string' ? (
              <div key={heading} role="columnheader">
                {heading}
              </div>
            ) : (
              <div key={heading.label} role="columnheader" className="flex items-center gap-1">
                {heading.label}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`About ${heading.label}`}
                        className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      />
                    }
                  >
                    <InfoCircle size={14} aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>{heading.hint}</TooltipContent>
                </Tooltip>
              </div>
            ),
          )}
        </TooltipProvider>
      </div>
      <div role="rowgroup">{children}</div>
    </div>
  );
}

/** `dropTarget` marks the row that receives files dragged onto it. */
function DataListRow({
  className,
  dropTarget = false,
  ...props
}: React.ComponentProps<'div'> & { dropTarget?: boolean }) {
  return (
    <div
      role="row"
      data-slot="data-list-row"
      data-drop-target={dropTarget || undefined}
      className={cn(
        'relative grid min-w-0 gap-1 border-b px-2 py-2.5 transition-colors hover:bg-muted/50 list-wide:grid-cols-(--data-list-columns) list-wide:items-center list-wide:gap-4 [&_[data-slot=data-list-actions]]:relative [&_[data-slot=data-list-actions]]:z-10',
        'data-drop-target:bg-primary-subtle data-drop-target:ring-2 data-drop-target:ring-ring data-drop-target:ring-inset',
        className,
      )}
      {...props}
    />
  );
}

const dataListCellVariants = cva('flex min-w-0 flex-wrap items-center gap-2 wrap-anywhere', {
  variants: {
    weight: { normal: '', strong: 'font-medium' },
    /** `line` keeps leading controls and a truncating name on one line once columns appear. */
    flow: { wrap: '', line: 'list-wide:flex-nowrap' },
    /** `full` spans every column, for row-level messages below the cells. */
    span: { cell: '', full: 'col-span-full' },
  },
  defaultVariants: { weight: 'normal', flow: 'wrap', span: 'cell' },
});

function DataListCell({
  className,
  weight,
  flow,
  span,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof dataListCellVariants>) {
  return (
    <div
      role="cell"
      data-slot="data-list-cell"
      className={cn(dataListCellVariants({ weight, flow, span, className }))}
      {...props}
    />
  );
}

const dataListSecondaryVariants = cva('line-clamp-2 text-muted-foreground', {
  variants: {
    /** `wide` hides the cell in the stacked layout, for rows that already summarize it under the name. */
    visibility: { always: '', wide: 'list-stacked:hidden' },
  },
  defaultVariants: { visibility: 'always' },
});

function DataListSecondary({
  className,
  visibility,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof dataListSecondaryVariants>) {
  return <DataListCell className={cn(dataListSecondaryVariants({ visibility, className }))} {...props} />;
}

function DataListActions({ className, ...props }: React.ComponentProps<'div'>) {
  return <DataListCell data-slot="data-list-actions" className={cn('justify-end', className)} {...props} />;
}

function DataListLink({ className, render, ...props }: useRender.ComponentProps<'a'>) {
  return useRender({
    defaultTagName: 'a',
    props: mergeProps<'a'>(
      {
        className: cn(
          'min-w-0 truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline',
          className,
        ),
      },
      props,
    ),
    render,
    state: { slot: 'data-list-link' },
  });
}

function DataListButton({
  className,
  weight = 'normal',
  ...props
}: React.ComponentProps<'button'> & { weight?: 'normal' | 'strong' }) {
  return (
    <button
      type="button"
      data-slot="data-list-link"
      className={cn(
        'min-w-0 truncate text-left outline-none after:absolute after:inset-0 focus-visible:underline',
        weight === 'strong' ? 'font-semibold' : 'font-medium',
        className,
      )}
      {...props}
    />
  );
}

export { DataList, DataListButton, DataListRow, DataListCell, DataListSecondary, DataListActions, DataListLink };
