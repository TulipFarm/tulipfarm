import type { ReactNode } from 'react';
import { Button, Section } from 'react-email';

export interface EmailButtonProps {
  href: string;
  children: ReactNode;
}

export function EmailButton({ href, children }: EmailButtonProps) {
  return (
    <Section className="mt-8 text-center">
      <Button
        href={href}
        className="box-border inline-block rounded-md bg-primary px-7 py-3 text-center text-base font-semibold text-primary-foreground no-underline"
      >
        {children}
      </Button>
    </Section>
  );
}
