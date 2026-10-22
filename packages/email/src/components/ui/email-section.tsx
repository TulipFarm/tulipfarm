import type { ReactNode } from 'react';
import { Section } from 'react-email';

export function EmailSection({ children }: { children: ReactNode }) {
  return <Section className="px-2 pt-8 sm:px-6">{children}</Section>;
}
