import type { ComponentProps } from 'react';

/**
 * A borderless text field that grows with its content, for writing a title or a body in place,
 * as on a document. `title` is large and bold; `body` reads as normal text.
 */
export function BareText({
  look = 'body',
  ...props
}: Omit<ComponentProps<'textarea'>, 'className' | 'style'> & { look?: 'title' | 'body' }) {
  return (
    <textarea
      rows={1}
      {...props}
      className={
        look === 'title'
          ? 'field-sizing-content block w-full resize-none border-0 bg-transparent p-0 text-xl font-semibold leading-snug outline-none placeholder:text-muted-foreground disabled:opacity-100'
          : 'field-sizing-content block min-h-16 w-full resize-none border-0 bg-transparent p-0 text-sm leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-100'
      }
    />
  );
}
