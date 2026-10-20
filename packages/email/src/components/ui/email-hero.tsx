import type { ReactNode } from 'react';
import { Heading, Section, Text } from 'react-email';

export interface EmailHeroProps {
  eyebrow: string;
  title: string;
  description: ReactNode;
  children?: ReactNode;
}

export function EmailHero({ eyebrow, title, description, children }: EmailHeroProps) {
  return (
    <Section className="rounded-2xl bg-muted px-6 py-10 text-center sm:px-12 sm:py-14 dark:bg-muted-dark">
      <Text className="m-0 mb-8 text-lg font-semibold tracking-tight text-foreground dark:text-foreground-dark">
        tulipfarm<span className="text-primary-text dark:text-primary-text-dark">.</span>
      </Text>
      <Text className="m-0 mb-3 text-xs font-semibold uppercase tracking-widest text-primary-text dark:text-primary-text-dark">
        {eyebrow}
      </Text>
      <Heading
        as="h1"
        className="m-0 mb-4 text-3xl font-semibold tracking-tight text-foreground dark:text-foreground-dark"
      >
        {title}
      </Heading>
      <Text className="mx-auto m-0 max-w-[400px] text-base text-muted-foreground dark:text-muted-foreground-dark">
        {description}
      </Text>
      {children}
    </Section>
  );
}
