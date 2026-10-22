import type { ReactNode } from 'react';
import { Text } from 'react-email';

const variants = {
  body: 'm-0 mb-3 text-sm text-foreground dark:text-foreground-dark',
  muted: 'm-0 mb-3 text-sm text-muted-foreground dark:text-muted-foreground-dark',
  emphasis: 'm-0 font-semibold text-foreground dark:text-foreground-dark',
} as const;

export interface EmailTextProps {
  variant?: keyof typeof variants;
  children: ReactNode;
}

export function EmailText({ variant = 'body', children }: EmailTextProps) {
  return <Text className={variants[variant]}>{children}</Text>;
}

export function EmailStrong({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-foreground dark:text-foreground-dark">{children}</span>;
}
