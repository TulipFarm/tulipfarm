import { Link, Section, Text } from 'react-email';

export interface EmailLinkFallbackProps {
  label: string;
  href: string;
}

export function EmailLinkFallback({ label, href }: EmailLinkFallbackProps) {
  return (
    <Section className="mb-6">
      <Text className="m-0 mb-2 text-sm text-muted-foreground dark:text-muted-foreground-dark">{label}</Text>
      <Section className="rounded-xl border border-solid border-border bg-background px-4 py-3 dark:border-border-dark dark:bg-background-dark">
        <Link
          href={href}
          className="break-all font-mono text-xs text-primary-text no-underline dark:text-primary-text-dark"
        >
          {href}
        </Link>
      </Section>
    </Section>
  );
}
